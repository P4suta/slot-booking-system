import { DurableObject } from "cloudflare:workers"
import type {
  CustomerHandle,
  EncodedTicket,
  ShopState as ShopStateWire,
  StaffShopState,
  TicketId,
} from "@booking/core"
import { Effect } from "effect"
import { AlarmScheduler } from "./AlarmScheduler.js"
import { Broadcaster } from "./Broadcaster.js"
import { type QueueAction, type QueueResult, runDispatch } from "./Dispatcher.js"
import { ensureDurableObjectSchema } from "./migrations.js"
import { persistenceLayer } from "./Persistence/index.js"
import {
  getByHandle,
  getTicketById,
  listDecodedWaitingTickets,
  listTickets,
  lookupActiveIdByHandle,
} from "./Persistence/queries.js"
import { buildShopState, buildStaffShopState } from "./Projector.js"
import { WsLifecycle } from "./WsLifecycle.js"
import { logWsBroadcast } from "./wsLifecycleLog.js"

export type { QueueAction, QueueResult }

type Env = {
  DB: D1Database
  GRACE_TTL_MIN?: string
  SERVING_THRESHOLD_MS?: string
  BROADCAST_COALESCE_MS?: string
}

const GRACE_TTL_DEFAULT_MIN = 10

/**
 * QueueShop — the single-writer Durable Object actor (ADR-0053).
 * One instance per deployment, keyed by `idFromName("shop")`. The
 * actor model serialises every concurrent write so the FIFO queue
 * is consistent without locks; the DO's local SQLite is the
 * canonical event log + projection. The alarm tick fires the
 * grace-period TTL sweep (PendingNoShow tickets whose
 * `markedAt + GRACE_TTL_MIN` has elapsed → NoShow, ADR-0074)
 * and reschedules itself to the next earliest deadline.
 */
export class QueueShop extends DurableObject<Env> {
  private readonly sql: SqlStorage
  private readonly broadcaster: Broadcaster
  private readonly scheduler: AlarmScheduler
  private readonly wsLifecycle: WsLifecycle

  // Wire v6 (ADR-0081) — VectorClock advances once per broadcast so
  // the client can detect snapshot/delta gaps. The DO is single-writer
  // so one site id suffices; future multi-replica designs (read-only
  // mirrors / disaster-recovery clones) can extend this without
  // changing the wire shape.
  private static readonly SITE_ID = "queueShop"

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.sql = state.storage.sql
    this.broadcaster = new Broadcaster({
      siteId: QueueShop.SITE_ID,
      getWebSockets: () => this.ctx.getWebSockets(),
      getTags: (ws) => this.ctx.getTags(ws),
      coalesceMs: Number(env.BROADCAST_COALESCE_MS) || 100,
      buildAnonymous: () => this.computeAnonymousShopState(),
      buildStaff: () => this.computeStaffShopState(),
      onBroadcast: (sockets, ms, bytes, failed) => {
        logWsBroadcast(sockets, ms, bytes, failed)
      },
    })
    this.scheduler = new AlarmScheduler({
      ttlMs: (Number(env.GRACE_TTL_MIN) || GRACE_TTL_DEFAULT_MIN) * 60_000,
      setAlarm: (deadlineMs) => this.ctx.storage.setAlarm(deadlineMs),
      sql: this.sql,
    })
    this.wsLifecycle = new WsLifecycle({
      acceptWebSocket: (ws, tags) => {
        this.ctx.acceptWebSocket(ws, [...tags])
      },
      setAutoResponse: (req, resp) => {
        this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(req, resp))
      },
      connect: (ws, capability) => this.broadcaster.connect(ws, capability),
    })
    void state.blockConcurrencyWhile(() => {
      ensureDurableObjectSchema(this.sql)
      this.scheduler.rehydrate()
      return Promise.resolve()
    })
  }

  async dispatch(action: QueueAction): Promise<QueueResult> {
    // ADR-0069: detect idempotent merge for IssueTicket BEFORE the
    // use case runs. If the active set already holds a ticket with
    // this handle, IssueTicket short-circuits and returns that same
    // ticket — the HTTP layer surfaces this as 200 OK + merged:true.
    const issueExistedId =
      action.type === "IssueTicket" ? lookupActiveIdByHandle(this.sql, action.handle) : undefined
    const result = await Effect.runPromise(
      runDispatch(action, issueExistedId).pipe(Effect.provide(persistenceLayer(this.sql))),
    )
    if (result.ok) {
      // The projection is broadcast on success only; failed actions
      // do not change shop state, so re-emitting the same payload
      // would just churn the wire without adding information.
      await this.broadcaster.publish()
      // Update the alarm heap with the post-state — PendingNoShow
      // transitions schedule a TTL expiry, every other terminal
      // state cancels any prior schedule on that ticket id.
      await this.syncSchedulerFromResult(result)
    }
    return result
  }

  /**
   * Map a dispatch result onto the alarm heap. Single-ticket
   * results inspect the post-state; batch results (`CallBatch`)
   * cancel every member since `Called` never expires through the
   * scheduler. `void` results (`CheckIn`) leave the heap alone.
   */
  private async syncSchedulerFromResult(result: QueueResult): Promise<void> {
    if (!result.ok) return
    if ("tickets" in result) {
      for (const t of result.tickets) this.scheduler.cancel(t.id as TicketId)
      return
    }
    if ("ticket" in result) {
      const ticket = result.ticket
      if (ticket.state === "PendingNoShow") {
        const markedMs = Date.parse(ticket.markedAt)
        if (!Number.isNaN(markedMs)) {
          const ttlMs = (Number(this.env.GRACE_TTL_MIN) || GRACE_TTL_DEFAULT_MIN) * 60_000
          await this.scheduler.schedule({
            ticketId: ticket.id as TicketId,
            deadlineMs: markedMs + ttlMs,
            kind: "PendingNoShowExpiry",
          })
        }
        return
      }
      this.scheduler.cancel(ticket.id as TicketId)
    }
  }

  /** Read the full ticket projection — JSON-safe encoded shape. */
  listTickets(): Promise<readonly EncodedTicket[]> {
    return Promise.resolve(listTickets(this.sql))
  }

  /** Single-row lookup by id — `null` when unknown. */
  getTicketById(id: TicketId): Promise<EncodedTicket | null> {
    return Promise.resolve(getTicketById(this.sql, id))
  }

  /** Active-set handle lookup (ADR-0069) — `null` when no active match. */
  getByHandle(handle: CustomerHandle): Promise<EncodedTicket | null> {
    return Promise.resolve(getByHandle(this.sql, handle))
  }

  /**
   * Hibernating WebSocket entry — Cloudflare Workers Durable Object
   * runtime forwards `Upgrade: websocket` requests to this method
   * (set up by the Hono router at `/api/v1/queue/feed`). The DO
   * accepts the server side via `ctx.acceptWebSocket(...)` so the
   * actor can hibernate between events without dropping live
   * connections; ticket-state messages reach every attached socket
   * through {@link broadcastProjection}.
   *
   * See ADR-0061 (DO Hibernating WebSocket projection feed).
   */
  override fetch(request: Request): Promise<Response> {
    return this.wsLifecycle.accept(request)
  }

  override webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string): Promise<void> {
    this.wsLifecycle.handleMessage(ws, msg)
    return Promise.resolve()
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    this.wsLifecycle.handleClose(ws, code, reason, wasClean)
  }

  override webSocketError(ws: WebSocket, err: unknown): void {
    this.wsLifecycle.handleError(ws, err)
  }

  /**
   * Build the anonymous projection payload — staff PII never
   * crosses the WebSocket feed. Mirrors the public `GET /api/v1/queue`
   * shape so the client renders the same view from either source.
   *
   * v2 (ADR-0062 / 0063 / 0065): `lane` partitions the queue and
   * `displaySeq` controls per-lane order; `calling[]` and
   * `serving[]` replace the v1 single `serving` field.
   *
   * v3 (ADR-0066 / 0067): waiting tickets carry `appointmentAt`,
   * the payload surfaces `nextReservationDeadline` (the earliest
   * reservation `appointmentAt` among Waiting tickets, or null) so
   * the staff Kanban / customer countdown render without a second
   * fetch.
   *
   * v4 (ADR-0071, refines ADR-0061): every ProjectionEntry carries
   * `state` (Waiting / Called / Served / ...) and `waitingPreview`
   * exposes every Waiting ticket (cap removed). `state` is public
   * information (the in-store monitor already shows it) — only the
   * customer-identifying fields (kana, last4, freeText) remain
   * staff-only. The expanded preview means `/ticket` can resolve
   * its own state from the WS feed alone without a follow-up
   * `ticketByHandle` round-trip on every broadcast, which is what
   * was consuming `RL_VERIFY` budget under v3.
   */
  private projectorInputs() {
    return {
      tickets: listTickets(this.sql),
      decodedWaiting: listDecodedWaitingTickets(this.sql),
      nowMs: Date.now(),
      servingThresholdMs: Number(this.env.SERVING_THRESHOLD_MS) || 30_000,
    }
  }

  private computeAnonymousShopState(): Promise<ShopStateWire> {
    return Promise.resolve(buildShopState(this.projectorInputs()))
  }

  private computeStaffShopState(): Promise<StaffShopState> {
    return Promise.resolve(buildStaffShopState(this.projectorInputs()))
  }

  override async alarm(): Promise<void> {
    const startedAt = Date.now()
    const expired = await this.scheduler.tick(Date.now())
    let succeeded = 0
    let failed = 0
    for (const ticketId of expired) {
      try {
        const result = await this.dispatch({
          type: "MarkNoShow",
          ticketId,
          actor: "system",
        })
        if (result.ok) {
          succeeded += 1
        } else {
          failed += 1
        }
      } catch (err) {
        failed += 1
        console.error(
          JSON.stringify({
            _tag: "AlarmSweepError",
            code: "I_DO_ALARM_ERROR",
            severity: "infrastructure",
            ticketId,
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }
    console.warn(
      JSON.stringify({
        _tag: "AlarmSweep",
        code: "I_DO_ALARM",
        severity: "infrastructure",
        candidates: expired.length,
        succeeded,
        failed,
        ms: Date.now() - startedAt,
      }),
    )
  }
}
