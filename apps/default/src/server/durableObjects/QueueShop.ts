import { DurableObject } from "cloudflare:workers"
import {
  type BusinessTimeZone,
  CallBatch,
  CallNext,
  CallSpecific,
  CancelTicket,
  CheckIn,
  type Clock,
  type ConcurrencyError,
  type CustomerHandle,
  codeOf,
  type DomainError,
  type IdGenerator,
  InstantSchema,
  IssueTicket,
  type Lane,
  type Logger,
  MarkNoShow,
  MarkServed,
  type NonEmptyReadonlyArray,
  Recall,
  Reorder,
  RescheduleTicket,
  reservationsByDeadline,
  StartServing,
  type StorageError,
  SystemClockLive,
  type Ticket,
  type TicketId,
  type TicketRepository,
  TicketSchema,
  UlidIdGeneratorLive,
} from "@booking/core"
import { Cause, Effect, Layer, Schema } from "effect"
import { DurableObjectTicketRepositoryLive } from "../adapters/DurableObjectTicketRepositoryLive.js"
import { WorkersLoggerLive } from "../adapters/WorkersLoggerLive.js"
import { ensureDurableObjectSchema } from "./schema.js"
import { logWsAccept, logWsBroadcast, logWsClose, logWsError } from "./wsLifecycleLog.js"

type Env = {
  DB: D1Database
  NO_SHOW_TIMEOUT_SECONDS?: string
}

/**
 * Action dispatched by the worker to the single QueueShop instance.
 * Discriminated union over the use cases; the DO routes each action
 * through the matching `application/usecases/queue/` entry point.
 *
 * Per ADR-0062 / ADR-0063 / ADR-0065 the operator-grade actions
 * (CallSpecific / CallBatch / StartServing / Reorder) join the
 * original five so the action surface stays small (10 total) but
 * each operator intent has a named entry.
 */
export type QueueAction =
  | {
      type: "IssueTicket"
      handle: CustomerHandle
      freeText: string | null
      lane?: Lane
      // ISO-8601 instant string. The DO RPC boundary serialises every
      // arg through structuredClone, which rejects Temporal.Instant —
      // the conversion to/from `Temporal.Instant` happens inside the
      // dispatch closure so the wire stays JSON-safe.
      appointmentAt?: string
    }
  | { type: "CallNext"; actor: "staff" | "system"; lane?: Lane }
  | { type: "CallSpecific"; ticketId: TicketId; actor: "staff" | "system" }
  | { type: "CallBatch"; ticketIds: NonEmptyReadonlyArray<TicketId>; actor: "staff" | "system" }
  | { type: "StartServing"; ticketId: TicketId; actor: "staff" | "system" }
  | { type: "MarkServed"; ticketId: TicketId }
  | { type: "MarkNoShow"; ticketId: TicketId; actor: "staff" | "system" }
  | { type: "Recall"; ticketId: TicketId; actor: "staff" | "system" }
  | {
      type: "Reorder"
      ticketId: TicketId
      afterTicketId: TicketId | null
      actor: "staff" | "system"
    }
  | {
      type: "CancelTicket"
      ticketId: TicketId
      actor: "customer" | "staff"
      reason: string
      handle?: CustomerHandle
    }
  | { type: "CheckIn"; ticketId: TicketId }
  | {
      type: "RescheduleTicket"
      ticketId: TicketId
      newAppointmentAt: string
      granularity: 15 | 30 | 60
      tz: string
      capacity: number
      actor: "customer" | "staff"
      handle?: CustomerHandle
    }

/**
 * The Worker boundary serialises every DO RPC return through
 * `structuredClone`, which rejects `Temporal.Instant` values (no
 * default cloner). We re-encode the ticket via `Schema.encode` so the
 * wire shape is JSON-safe; consumers re-decode if they need typed
 * Temporal access.
 */
export type EncodedTicket = (typeof TicketSchema)["Encoded"]

/**
 * Result envelope. Single-ticket actions return `ticket`; CallBatch
 * returns `tickets` (the array of every member that landed Called).
 * Failure carries the `_tag + code` pair the boundary surfaces.
 *
 * `merged` (ADR-0069) is set on the single-ticket variant when an
 * IssueTicket call short-circuited to an existing active ticket
 * (handle already held). The HTTP layer surfaces this as 200 OK
 * (vs 201 Created for a fresh issue).
 */
export type QueueResult =
  | { ok: true; ticket: EncodedTicket; merged?: boolean }
  | { ok: true; tickets: readonly EncodedTicket[] }
  | { ok: true }
  | { ok: false; error: { _tag: string; code: string } }

const encodeTicket = (t: Ticket): EncodedTicket => Schema.encodeUnknownSync(TicketSchema)(t)

const NO_SHOW_TIMEOUT_DEFAULT_SECONDS = 300

/**
 * QueueShop — the single-writer Durable Object actor (ADR-0053).
 * One instance per deployment, keyed by `idFromName("shop")`. The
 * actor model serialises every concurrent write so the FIFO queue
 * is consistent without locks; the DO's local SQLite is the
 * canonical event log + projection. The alarm tick fires the no-show
 * sweep (`Called` tickets older than `NO_SHOW_TIMEOUT_SECONDS` →
 * `NoShow`) and drains the outbox to D1.
 */
export class QueueShop extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.sql = state.storage.sql
    void state.blockConcurrencyWhile(() => {
      ensureDurableObjectSchema(this.sql)
      return Promise.resolve()
    })
  }

  private layer() {
    const repo = DurableObjectTicketRepositoryLive(this.sql)
    return Layer.mergeAll(SystemClockLive, UlidIdGeneratorLive, repo, WorkersLoggerLive)
  }

  async dispatch(action: QueueAction): Promise<QueueResult> {
    const layer = this.layer()
    type DispatchOk = Ticket | readonly Ticket[] | undefined
    type DispatchErr = DomainError | ConcurrencyError | StorageError
    type DispatchDeps = Clock | IdGenerator | TicketRepository | Logger
    let eff: Effect.Effect<DispatchOk, DispatchErr, DispatchDeps>
    // ADR-0069: detect idempotent merge for IssueTicket BEFORE the
    // use case runs. If the active set already holds a ticket with
    // this handle, IssueTicket short-circuits and returns that same
    // ticket — the HTTP layer surfaces this as 200 OK + merged:true.
    let issueExistedId: string | undefined
    if (action.type === "IssueTicket") {
      const row = this.sql
        .exec(
          "SELECT id FROM tickets WHERE name_kana = ? AND phone_last4 = ? AND state IN ('Waiting','Called','Serving') LIMIT 1",
          action.handle.nameKana,
          action.handle.phoneLast4,
        )
        .toArray()[0]
      issueExistedId = row?.id as string | undefined
    }
    switch (action.type) {
      case "IssueTicket": {
        const appointmentAt =
          action.appointmentAt !== undefined
            ? Schema.decodeUnknownSync(InstantSchema)(action.appointmentAt)
            : undefined
        eff = IssueTicket({
          handle: action.handle,
          freeText: action.freeText as Ticket["freeText"],
          ...(action.lane !== undefined ? { lane: action.lane } : {}),
          ...(appointmentAt !== undefined ? { appointmentAt } : {}),
        })
        break
      }
      case "CallNext":
        eff = CallNext(action.lane, action.actor)
        break
      case "CallSpecific":
        eff = CallSpecific(action.ticketId, action.actor)
        break
      case "CallBatch":
        eff = CallBatch(action.ticketIds, action.actor)
        break
      case "StartServing":
        eff = StartServing(action.ticketId, action.actor)
        break
      case "MarkServed":
        eff = MarkServed(action.ticketId)
        break
      case "MarkNoShow":
        eff = MarkNoShow(action.ticketId, action.actor)
        break
      case "Recall":
        eff = Recall(action.ticketId, action.actor)
        break
      case "Reorder":
        eff = Reorder(action.ticketId, action.afterTicketId, action.actor)
        break
      case "CancelTicket":
        eff = CancelTicket(action.ticketId, action.actor, action.reason, action.handle)
        break
      case "CheckIn":
        eff = CheckIn(action.ticketId)
        break
      case "RescheduleTicket": {
        const newAppointmentAt = Schema.decodeUnknownSync(InstantSchema)(action.newAppointmentAt)
        eff = RescheduleTicket({
          ticketId: action.ticketId,
          newAppointmentAt,
          granularity: action.granularity,
          tz: action.tz as BusinessTimeZone,
          capacity: action.capacity,
          actor: action.actor,
          ...(action.handle !== undefined ? { handle: action.handle } : {}),
        })
        break
      }
    }
    const result: QueueResult = await Effect.runPromise(
      Effect.matchCauseEffect(eff, {
        onSuccess: (out: DispatchOk): Effect.Effect<QueueResult> => {
          if (out === undefined) {
            // CheckIn returns void — the customer-side audit event
            // does not change the ticket shape the wire surfaces;
            // the projection broadcast emitted below is enough.
            return Effect.succeed({ ok: true } satisfies QueueResult)
          }
          if (Array.isArray(out)) {
            const tickets = out as readonly Ticket[]
            return Effect.succeed({
              ok: true,
              tickets: tickets.map(encodeTicket),
            } satisfies QueueResult)
          }
          const ticket = out as Ticket
          const merged = issueExistedId !== undefined && issueExistedId === ticket.id
          return Effect.succeed({
            ok: true,
            ticket: encodeTicket(ticket),
            ...(merged ? { merged: true } : {}),
          } satisfies QueueResult)
        },
        onFailure: (cause) => {
          const fails = cause.reasons.filter(Cause.isFailReason)
          const first = fails[0]?.error
          console.error(
            JSON.stringify({
              _tag: "DispatchFailure",
              code: "I_DO_DISPATCH_FAILURE",
              severity: "infrastructure",
              actionType: action.type,
              errorTag: first?._tag ?? "Defect",
              errorCode: first !== undefined ? codeOf(first) : "E_DEFECT",
              storageReason: first?._tag === "Storage" ? first.reason : undefined,
              storageCause:
                first?._tag === "Storage"
                  ? first.cause instanceof Error
                    ? first.cause.message
                    : String(first.cause)
                  : undefined,
            }),
          )
          return Effect.succeed({
            ok: false,
            error: {
              _tag: first?._tag ?? "Defect",
              code: first !== undefined ? codeOf(first) : "E_DEFECT",
            },
          } satisfies QueueResult)
        },
      }).pipe(Effect.provide(layer)),
    )
    if (result.ok) {
      // The projection is broadcast on success only; failed actions
      // do not change shop state, so re-emitting the same payload
      // would just churn the wire without adding information.
      await this.broadcastProjection()
    }
    return result
  }

  /**
   * Read the full ticket projection. Returns the encoded shape (JSON-
   * safe) so the worker can pass it back over the structuredClone
   * boundary without DataCloneError.
   */
  listTickets(): Promise<readonly EncodedTicket[]> {
    const rows = this.sql.exec("SELECT payload FROM tickets ORDER BY seq ASC").toArray()
    return Promise.resolve(rows.map((r) => JSON.parse(r.payload as string) as EncodedTicket))
  }

  /**
   * Single-row lookup by primary key. Used by `/api/v1/tickets/me`
   * so the customer self-fetch path is O(log N) on the SQLite
   * `id`-keyed btree rather than O(N) JSON-decode of every ticket
   * in the table. The encoding shape matches `listTickets`'s element
   * type — same `JSON.parse(payload)` so the wire is JSON-safe under
   * structuredClone.
   *
   * Returns `null` for an unknown id; the router maps that to the
   * standard `TicketNotFound` 404.
   */
  getTicketById(id: TicketId): Promise<EncodedTicket | null> {
    const rows = this.sql.exec("SELECT payload FROM tickets WHERE id = ? LIMIT 1", id).toArray()
    const r = rows[0]
    if (r === undefined) return Promise.resolve(null)
    return Promise.resolve(JSON.parse(r.payload as string) as EncodedTicket)
  }

  /**
   * Active-set handle lookup (ADR-0069). Served off the partial UNIQUE
   * index `uq_tickets_handle_active`, which makes the predicate
   * (state IN active × name_kana × phone_last4) an O(log N) index seek
   * with at most one matching row by construction. Powers the
   * customer recovery endpoint `GET /api/v1/tickets/by-handle`.
   */
  getByHandle(handle: CustomerHandle): Promise<EncodedTicket | null> {
    const rows = this.sql
      .exec(
        "SELECT payload FROM tickets WHERE name_kana = ? AND phone_last4 = ? AND state IN ('Waiting','Called','Serving') LIMIT 1",
        handle.nameKana,
        handle.phoneLast4,
      )
      .toArray()
    const r = rows[0]
    if (r === undefined) return Promise.resolve(null)
    return Promise.resolve(JSON.parse(r.payload as string) as EncodedTicket)
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
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 })
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    logWsAccept()
    // Send the current projection on connect so the new client has
    // full state immediately rather than waiting for the next mutation.
    await this.sendProjectionTo(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Hibernating-WebSocket lifecycle handler. The projection feed is
   * server-push only; client messages are accepted but not
   * processed. Future bidirectional exchanges (e.g. resume-token
   * negotiation) hook in here.
   */
  override async webSocketMessage(_ws: WebSocket, _msg: ArrayBuffer | string): Promise<void> {
    // intentional no-op; the feed is unidirectional today
  }

  override webSocketClose(_ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    // No-op on the runtime side: by the time this lifecycle handler
    // fires the socket is already in a closing state, and the
    // Hibernating runtime has already removed it from
    // `ctx.getWebSockets()`. Calling `ws.close(...)` here throws
    // because the socket is no longer mutable from server code.
    // The structured `ws.close` log is the operator's signal that
    // the socket actually disconnected (close code + reason
    // surface "client navigated away" vs "1006 abnormal closure").
    logWsClose(code, reason, wasClean)
  }

  override webSocketError(_ws: WebSocket, err: unknown): void {
    // No-op on the runtime side: same lifecycle invariant as
    // `webSocketClose`. The runtime surfaces the underlying error
    // via the close handshake; we have no recovery path inside the
    // DO that does not race with hibernation. The structured log
    // gives the operator visibility into errored disconnects.
    logWsError(err instanceof Error ? err.message : String(err))
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
   * `state` (Waiting / Called / Serving / ...) and `waitingPreview`
   * exposes every Waiting ticket (cap removed). `state` is public
   * information (the in-store monitor already shows it) — only the
   * customer-identifying fields (kana, last4, freeText) remain
   * staff-only. The expanded preview means `/ticket` can resolve
   * its own state from the WS feed alone without a follow-up
   * `ticketByHandle` round-trip on every broadcast, which is what
   * was consuming `RL_VERIFY` budget under v3.
   */
  private async projectionPayload(): Promise<string> {
    const tickets = await this.listTickets()
    const project = (t: EncodedTicket) => ({
      id: t.id,
      seq: t.seq,
      lane: t.lane,
      displaySeq: t.displaySeq,
      appointmentAt: t.appointmentAt,
      state: t.state,
    })
    const waiting = tickets
      .filter((t) => t.state === "Waiting")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    const calling = tickets
      .filter((t) => t.state === "Called")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    const serving = tickets
      .filter((t) => t.state === "Serving")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    const laneCount = (lane: Lane) => waiting.filter((t) => t.lane === lane).length
    // Decode just the waiting subset to drive the EDF deadline read;
    // the rest of the payload stays in encoded form to keep the wire
    // shape JSON-safe under structuredClone.
    const decodedWaitingTickets = this.listDecodedWaitingTickets()
    const ranked = reservationsByDeadline({ tickets: decodedWaitingTickets })
    const nextDeadline = ranked[0]?.appointmentAt ?? null
    return JSON.stringify({
      ok: true,
      v: 4,
      waitingCount: waiting.length,
      laneCounts: {
        walkIn: laneCount("walkIn"),
        priority: laneCount("priority"),
        reservation: laneCount("reservation"),
      },
      calling: calling.map(project),
      serving: serving.map(project),
      waitingPreview: waiting.map(project),
      nextReservationDeadline: nextDeadline !== null ? String(nextDeadline) : null,
    })
  }

  private listDecodedWaitingTickets(): Map<TicketId, Ticket> {
    const rows = this.sql.exec("SELECT payload FROM tickets WHERE state = 'Waiting'").toArray()
    const m = new Map<TicketId, Ticket>()
    for (const r of rows) {
      const decoded = Schema.decodeUnknownSync(TicketSchema)(JSON.parse(r.payload as string))
      m.set(decoded.id, decoded)
    }
    return m
  }

  private async sendProjectionTo(ws: WebSocket): Promise<void> {
    try {
      ws.send(await this.projectionPayload())
    } catch (err) {
      // The socket may have been closed between accept + send; the
      // runtime evicts it from `ctx.getWebSockets()` on the next
      // tick. The send failure is therefore expected during normal
      // disconnect, but the operator dashboard still wants the
      // signal so a regression that drops every on-connect frame is
      // attributable.
      logWsError(`on-connect send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Fan out the current projection to every attached WebSocket.
   * Called from {@link dispatch} after a successful state change so
   * the customer landing page reflects the queue without polling.
   */
  private async broadcastProjection(): Promise<void> {
    const sockets = this.ctx.getWebSockets()
    if (sockets.length === 0) return
    const started = Date.now()
    const payload = await this.projectionPayload()
    let failed = 0
    for (const ws of sockets) {
      try {
        ws.send(payload)
      } catch (err) {
        failed += 1
        logWsError(`broadcast send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    logWsBroadcast(sockets.length, Date.now() - started, payload.length, failed)
  }

  override async alarm(): Promise<void> {
    const startedAt = Date.now()
    const timeoutSeconds = Number(
      this.env.NO_SHOW_TIMEOUT_SECONDS ?? NO_SHOW_TIMEOUT_DEFAULT_SECONDS,
    )
    const cutoff = new Date(Date.now() - timeoutSeconds * 1000).toISOString()
    const stale = this.sql
      .exec("SELECT id FROM tickets WHERE state = 'Called' AND called_at <= ?", cutoff)
      .toArray()
    let succeeded = 0
    let failed = 0
    for (const row of stale) {
      try {
        const result = await this.dispatch({
          type: "MarkNoShow",
          ticketId: row.id as TicketId,
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
            ticketId: typeof row.id === "string" ? row.id : JSON.stringify(row.id),
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
        candidates: stale.length,
        succeeded,
        failed,
        ms: Date.now() - startedAt,
      }),
    )
  }
}
