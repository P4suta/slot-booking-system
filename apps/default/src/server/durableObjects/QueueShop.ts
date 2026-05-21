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
  constantTimeStringEqual,
  type DomainError,
  type IdGenerator,
  InstantSchema,
  IssueTicket,
  type Lane,
  LapseAppointment,
  type Logger,
  MarkNoShow,
  MarkServed,
  MoveToOverdue,
  type NonEmptyReadonlyArray,
  Nudge,
  Recall,
  Reorder,
  RescheduleTicket,
  reservationsByDeadline,
  type StorageError,
  SystemClockLive,
  type Ticket,
  type TicketId,
  type TicketRepository,
  TicketSchema,
  UlidIdGeneratorLive,
} from "@booking/core"
import type { PushSubscription, SendPushResult } from "@booking/push"
import { sendPush } from "@booking/push"
import { Cause, Effect, Layer, Schema } from "effect"
import { DurableObjectTicketRepositoryLive } from "../adapters/DurableObjectTicketRepositoryLive.js"
import { WorkersLoggerLive } from "../adapters/WorkersLoggerLive.js"
import { ensureDurableObjectSchema } from "./schema.js"
import { logWsAccept, logWsBroadcast, logWsClose, logWsError } from "./wsLifecycleLog.js"

type Env = {
  DB: D1Database
  /** ADR-0072: seconds in `Called` before auto-`MoveToOverdue`. */
  OVERDUE_AFTER_CALLED_SECONDS?: string
  /** ADR-0072: minimum seconds between successive `Nudged` events. */
  NUDGE_INTERVAL_SECONDS?: string
  /** ADR-0072: cap on `nudgeCount` before terminal `MarkNoShow(system)`. */
  MAX_NUDGES?: string
  /** ADR-0075: grace seconds past `appointmentAt` before LapseAppointment. */
  APPOINTMENT_GRACE_SECONDS?: string
  /** ADR-0073: raw uncompressed P-256 public point (URL-safe base64). */
  VAPID_PUBLIC_KEY?: string
  /** ADR-0073: raw P-256 scalar (URL-safe base64). Worker secret. */
  VAPID_PRIVATE_KEY?: string
  /** ADR-0073: RFC 8292 subject URI (`mailto:` or `https:`). */
  VAPID_SUBJECT?: string
}

/**
 * Action dispatched by the worker to the single QueueShop instance.
 * Discriminated union over the use cases; the DO routes each action
 * through the matching `application/usecases/queue/` entry point.
 *
 * Per ADR-0062 / ADR-0065 / ADR-0071 / ADR-0072 / ADR-0075 the operator-
 * grade and system-driven actions (CallSpecific / CallBatch / Reorder /
 * MoveToOverdue / Nudge / LapseAppointment) join the base five so each
 * intent has a named entry.
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
  | { type: "MoveToOverdue"; ticketId: TicketId }
  | { type: "Nudge"; ticketId: TicketId; channel: "ws" | "push" }
  | { type: "LapseAppointment"; ticketId: TicketId }
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

/** Default ADR-0072 / ADR-0075 sweep parameters; each env-overridable. */
const OVERDUE_AFTER_CALLED_DEFAULT_SECONDS = 60
const NUDGE_INTERVAL_DEFAULT_SECONDS = 90
const MAX_NUDGES_DEFAULT = 3
const APPOINTMENT_GRACE_DEFAULT_SECONDS = 600

/**
 * The alarm sweep should re-fire at the earliest of the four ticks'
 * next-firing times; if the projection is empty we still re-arm so a
 * future Issue / Call has the alarm in place.
 */
const ALARM_FALLBACK_RE_ARM_SECONDS = 60

/**
 * ADR-0074 push-payload `kind` discriminator. `nextNudgeCount` is the
 * value the dispatched `Nudge` use case will write to the event log
 * (i.e. `current + 1`); when it reaches `maxNudges` the customer is
 * about to be NoShowed, so the SW renders `overdue-final` differently
 * (stronger UX). Otherwise the per-N variant `overdue-1` / `overdue-2`
 * / … is emitted so the SW can show a graded warning.
 *
 * Exported for unit-test coverage — the encrypted push body is
 * RFC 8291 aes128gcm and cannot be inspected at the integration
 * boundary, so the kind-derivation is pinned here as a pure function.
 */
export const pushKindFor = (nextNudgeCount: number, maxNudges: number): string =>
  nextNudgeCount >= maxNudges ? "overdue-final" : `overdue-${String(nextNudgeCount)}`

/**
 * QueueShop — the single-writer Durable Object actor (ADR-0053).
 * One instance per deployment, keyed by `idFromName("shop")`. The
 * actor model serialises every concurrent write so the FIFO queue
 * is consistent without locks; the DO's local SQLite is the
 * canonical event log + projection. The alarm tick runs the four-
 * step sweep from ADR-0072 / ADR-0075 (Called→Overdue, Overdue
 * nudge, Overdue→NoShow, Waiting-reservation→Cancelled) and
 * drains the outbox to D1.
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
          "SELECT id FROM tickets WHERE name_kana = ? AND phone_last4 = ? AND state IN ('Waiting','Called','Overdue') LIMIT 1",
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
      case "MoveToOverdue":
        eff = MoveToOverdue(action.ticketId)
        break
      case "Nudge":
        eff = Nudge(action.ticketId, action.channel)
        break
      case "LapseAppointment":
        eff = LapseAppointment(action.ticketId)
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
      // ADR-0074: any transition that lands a ticket in a terminal
      // state releases its push subscriptions immediately (same TTL
      // as the ticket aggregate per ADR-0009). Single-ticket
      // returners (`ticket`) tell us which row to reap; CallBatch
      // results an array (`tickets`) — same treatment per member.
      if ("ticket" in result) this.reapTerminalSubscriptions(result.ticket)
      else if ("tickets" in result) {
        for (const t of result.tickets) this.reapTerminalSubscriptions(t)
      }
      // Ensure the alarm sweep is armed (ADR-0072 / ADR-0075). The
      // alarm self-re-arms inside `alarm()`, but the first wake after
      // a fresh deployment or after the table has been idle requires
      // an explicit `setAlarm` here. Guarded by `getAlarm() === null`
      // so concurrent dispatches do not push the deadline forward.
      await this.ensureAlarmArmed()
    }
    return result
  }

  /**
   * Delete every push subscription for a ticket currently in a
   * terminal state (Served / NoShow / Cancelled); no-op for active
   * tickets. Invoked by `dispatch` after every successful action so
   * a transition that lands the ticket in a terminal state drains
   * its subscriptions in the same RPC round-trip (ADR-0074 PII reap).
   */
  private reapTerminalSubscriptions(ticket: EncodedTicket): void {
    if (ticket.state !== "Served" && ticket.state !== "NoShow" && ticket.state !== "Cancelled") {
      return
    }
    this.sql.exec("DELETE FROM push_subscriptions WHERE ticket_id = ?", ticket.id)
  }

  /**
   * Schedule the next alarm fire if and only if one is not already
   * pending. Called after every successful dispatch so the 4-tick
   * sweep (ADR-0072 / ADR-0075) starts running as soon as any state
   * transition could matter.
   */
  private async ensureAlarmArmed(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    if (existing !== null) return
    await this.ctx.storage.setAlarm(Date.now() + ALARM_FALLBACK_RE_ARM_SECONDS * 1000)
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
  /**
   * Register a Web Push subscription for the customer's active
   * ticket (ADR-0073 / ADR-0074). Customer-authenticated: the caller
   * supplies `(nameKana, phoneLast4)` and we compare against the
   * ticket's stored handle with `constantTimeStringEqual` before
   * accepting the row (cancel-pattern parity, CWE-208 protection).
   *
   * Idempotent: re-subscribing from the same device produces an
   * `INSERT OR REPLACE` on `(ticket_id, endpoint)`. The router
   * additionally validates the endpoint origin against the known
   * push-service hosts.
   *
   * Race window with `reapTerminalSubscriptions`: none. The DO is a
   * single-writer actor (ADR-0053); concurrent register + dispatch
   * calls are linearised by the runtime so the SELECT-then-INSERT
   * sequence below cannot interleave with a terminal-state DELETE.
   */
  registerPushSubscription(
    ticketId: TicketId,
    handle: CustomerHandle,
    subscription: PushSubscription,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const ticket = this.sql
      .exec("SELECT state, name_kana, phone_last4 FROM tickets WHERE id = ?", ticketId)
      .toArray()[0]
    if (ticket === undefined) {
      return Promise.resolve({ ok: false, reason: "TicketNotFound" })
    }
    const state = (ticket.state as string | null) ?? ""
    if (state === "Served" || state === "NoShow" || state === "Cancelled") {
      return Promise.resolve({ ok: false, reason: "TicketTerminal" })
    }
    const storedKana = (ticket.name_kana as string | null) ?? ""
    const storedPhone = (ticket.phone_last4 as string | null) ?? ""
    if (
      !constantTimeStringEqual(storedKana, handle.nameKana) ||
      !constantTimeStringEqual(storedPhone, handle.phoneLast4)
    ) {
      return Promise.resolve({ ok: false, reason: "PhoneMismatch" })
    }
    this.sql.exec(
      `INSERT INTO push_subscriptions (ticket_id, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ticket_id, endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth   = excluded.auth,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ticketId,
      subscription.endpoint,
      subscription.p256dh,
      subscription.auth,
    )
    return Promise.resolve({ ok: true })
  }

  /**
   * Customer-initiated unsubscribe (ADR-0074). Authenticated with the
   * same `(nameKana, phoneLast4)` pair as register; a `PhoneMismatch`
   * short-circuits to `{ ok: false, reason: "PhoneMismatch" }` so an
   * attacker with only an `endpoint` cannot delete arbitrary rows
   * (cancel-pattern parity, CWE-208 protection through
   * `constantTimeStringEqual`).
   *
   * Idempotent on the "no row" axis: a missing `ticketId` returns
   * `{ ok: true }` so a client retrying after a server timeout does
   * not see a spurious 404. Truly orphaned subscriptions (customer lost
   * the handle but the ticket still exists) are reaped on terminal-state
   * transition (`reapTerminalSubscriptions`) or on the next push-service
   * 410 inside the alarm sweep.
   */
  unregisterPushSubscription(
    ticketId: TicketId,
    handle: CustomerHandle,
    endpoint: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const ticket = this.sql
      .exec("SELECT name_kana, phone_last4 FROM tickets WHERE id = ?", ticketId)
      .toArray()[0]
    if (ticket === undefined) {
      // No ticket → silently OK (idempotent). The endpoint, if any,
      // is orphaned and will be reaped on next ticket terminal.
      return Promise.resolve({ ok: true })
    }
    const storedKana = (ticket.name_kana as string | null) ?? ""
    const storedPhone = (ticket.phone_last4 as string | null) ?? ""
    if (
      !constantTimeStringEqual(storedKana, handle.nameKana) ||
      !constantTimeStringEqual(storedPhone, handle.phoneLast4)
    ) {
      return Promise.resolve({ ok: false, reason: "PhoneMismatch" })
    }
    this.sql.exec(
      "DELETE FROM push_subscriptions WHERE ticket_id = ? AND endpoint = ?",
      ticketId,
      endpoint,
    )
    return Promise.resolve({ ok: true })
  }

  private listPushSubscriptions(ticketId: TicketId): readonly PushSubscription[] {
    const rows = this.sql
      .exec("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE ticket_id = ?", ticketId)
      .toArray()
    return rows.map((r) => ({
      endpoint: r.endpoint as string,
      p256dh: r.p256dh as string,
      auth: r.auth as string,
    }))
  }

  getByHandle(handle: CustomerHandle): Promise<EncodedTicket | null> {
    const rows = this.sql
      .exec(
        "SELECT payload FROM tickets WHERE name_kana = ? AND phone_last4 = ? AND state IN ('Waiting','Called','Overdue') LIMIT 1",
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
   * Build the anonymous projection payload — staff PII never crosses
   * the WebSocket feed. Mirrors the public `GET /api/v1/queue` shape
   * so the client renders the same view from either source.
   *
   * v4 (ADR-0071 / ADR-0072): `Serving` is removed, `Overdue` joins
   * `Called` as the post-call states. The payload exposes:
   *   - `calling[]` — Called tickets, sorted by displaySeq
   *   - `overdue[]` — Overdue tickets, sorted by displaySeq, each
   *     carrying `nudgeCount` so the customer-side de-dup keys
   *     `(calledAt, nudgeCount)` (per ADR-0072) can detect each
   *     successive `Nudged` event without polling.
   *
   * Older readers (v2 / v3) see the new `overdue[]` field as an
   * unknown property and ignore it per ADR-0061's `v` discriminator
   * forward-compatibility rule. The `serving[]` field is gone; v3
   * readers will render an empty serving column, which is the
   * intended deprecation path.
   */
  private async projectionPayload(): Promise<string> {
    const tickets = await this.listTickets()
    const project = (t: EncodedTicket) => ({
      id: t.id,
      seq: t.seq,
      lane: t.lane,
      displaySeq: t.displaySeq,
      appointmentAt: t.appointmentAt,
    })
    const projectOverdue = (t: EncodedTicket) => {
      // The encoded ticket is the discriminated union shape; for
      // overdue rows the `nudgeCount` field is present. We pluck it
      // through a typed indexed access rather than re-decoding the
      // full Schema.
      const nudgeCount = (t as { nudgeCount?: number }).nudgeCount ?? 0
      return { ...project(t), nudgeCount }
    }
    const waiting = tickets
      .filter((t) => t.state === "Waiting")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    const calling = tickets
      .filter((t) => t.state === "Called")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    const overdue = tickets
      .filter((t) => t.state === "Overdue")
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
      overdue: overdue.map(projectOverdue),
      waitingPreview: waiting.slice(0, 10).map(project),
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

  /**
   * Four-tick alarm sweep (ADR-0072 / ADR-0075):
   *
   *   - Tick 1 — `Called → Overdue`:  `now - called_at > OVERDUE_AFTER_CALLED`
   *   - Tick 2 — `Overdue` Nudge:     `now - last_nudged_at > NUDGE_INTERVAL ∧
   *                                   nudge_count < MAX_NUDGES`
   *   - Tick 3 — `Overdue → NoShow`:  `nudge_count ≥ MAX_NUDGES`
   *   - Tick 4 — `Waiting (reservation) → Cancelled`:
   *                                   `appointment_at + grace < now`
   *
   * Each tick is independent; the dispatched use case enforces its own
   * state guard so a row that has raced past the predicate (e.g.
   * Cancelled by the customer between the SELECT and the dispatch)
   * surfaces an `InvalidStateTransition` and is recorded as failed
   * rather than aborting the sweep.
   *
   * After every sweep `setAlarm()` re-arms for the next fire by
   * inspecting the projection — the earliest "next tick will need to
   * fire" instant wins. When the table is empty we fall back to
   * `ALARM_FALLBACK_RE_ARM_SECONDS` so the alarm survives idle periods.
   */
  override async alarm(): Promise<void> {
    const startedAt = Date.now()
    const overdueAfterCalled = Number(
      this.env.OVERDUE_AFTER_CALLED_SECONDS ?? OVERDUE_AFTER_CALLED_DEFAULT_SECONDS,
    )
    const nudgeInterval = Number(this.env.NUDGE_INTERVAL_SECONDS ?? NUDGE_INTERVAL_DEFAULT_SECONDS)
    const maxNudges = Number(this.env.MAX_NUDGES ?? MAX_NUDGES_DEFAULT)
    const appointmentGrace = Number(
      this.env.APPOINTMENT_GRACE_SECONDS ?? APPOINTMENT_GRACE_DEFAULT_SECONDS,
    )
    const nowMs = Date.now()
    const calledCutoff = new Date(nowMs - overdueAfterCalled * 1000).toISOString()
    const nudgeCutoff = new Date(nowMs - nudgeInterval * 1000).toISOString()
    const appointmentCutoff = new Date(nowMs - appointmentGrace * 1000).toISOString()

    // Tick 1: Called → Overdue. ADR-0072 spec is `now - calledAt >
    // OVERDUE_AFTER_CALLED_SECONDS`, i.e. `called_at < cutoff` — strict
    // inequality so a ticket whose calledAt is exactly `cutoff` is NOT
    // promoted in this tick but in the next one.
    const calledStale = this.sql
      .exec("SELECT id FROM tickets WHERE state = 'Called' AND called_at < ?", calledCutoff)
      .toArray()
    let tick1Ok = 0
    let tick1Err = 0
    for (const row of calledStale) {
      const result = await this.runSweepStep("MoveToOverdue", row.id as TicketId, () =>
        this.dispatch({ type: "MoveToOverdue", ticketId: row.id as TicketId }),
      )
      if (result) tick1Ok += 1
      else tick1Err += 1
    }

    // Tick 2: Overdue → Nudge (subject to MAX_NUDGES cap)
    // ADR-0073: if the ticket has Web Push subscriptions registered
    // and at least one push lands, the audit event records
    // `channel: "push"`; otherwise we fall back to the WebSocket
    // broadcast (`channel: "ws"`). Push is sent **before** the
    // Nudged event is appended so a 100% push-service outage does
    // not advance `nudgeCount` toward a silent NoShow while the
    // customer never hears anything; the event channel reflects
    // delivery truth instead of intent.
    //
    // Race trade-off: between `listPushSubscriptions` + `fanOutPush`
    // and the `dispatch` below, a concurrent Recall / MarkServed /
    // Cancel may flip the ticket out of Overdue. The push fan-out is
    // already in flight so the customer may receive a stray
    // "応答をお願いします" — acceptable because `/ticket` rehydrates
    // to the latest state on open. The Nudge dispatch then fails its
    // state guard (InvalidStateTransition), is logged as a sweep
    // step error, and the loop moves on without corrupting state.
    const overdueToNudge = this.sql
      .exec(
        `SELECT id, payload FROM tickets WHERE state = 'Overdue'
         AND nudge_count < ?
         AND (last_nudged_at IS NULL OR last_nudged_at < ?)`,
        maxNudges,
        nudgeCutoff,
      )
      .toArray()
    let tick2Ok = 0
    let tick2Err = 0
    for (const row of overdueToNudge) {
      const ticketId = row.id as TicketId
      // The projection row's `nudge_count` is the value *before* this
      // Tick 2 fires — the dispatched `Nudge` use case increments it
      // by one. ADR-0074 specifies the push payload's `kind` per the
      // **post-increment** count, so we precompute `nextNudgeCount`
      // here and hand it through to `fanOutPush`.
      const parsed = JSON.parse(row.payload as string) as {
        readonly displaySeq?: number
        readonly nudgeCount?: number
      }
      const displaySeq = parsed.displaySeq ?? 0
      const nextNudgeCount = (parsed.nudgeCount ?? 0) + 1
      const subs = this.listPushSubscriptions(ticketId)
      // Fan out push FIRST so the event channel reflects actual
      // delivery. `subs.length === 0` short-circuits to the
      // WebSocket-only path without touching the network.
      let channel: "ws" | "push" = "ws"
      if (subs.length > 0 && this.pushEnabled()) {
        const fan = await this.fanOutPush(ticketId, subs, displaySeq, nextNudgeCount, maxNudges)
        channel = fan.delivered >= 1 ? "push" : "ws"
      }
      const result = await this.runSweepStep("Nudge", ticketId, () =>
        this.dispatch({ type: "Nudge", ticketId, channel }),
      )
      if (result) tick2Ok += 1
      else tick2Err += 1
    }

    // Tick 3: Overdue → NoShow (after MAX_NUDGES nudges + one more
    // interval so the customer has a final reaction window after the
    // last push).
    const overdueToNoShow = this.sql
      .exec(
        `SELECT id FROM tickets WHERE state = 'Overdue'
         AND nudge_count >= ?
         AND last_nudged_at IS NOT NULL
         AND last_nudged_at < ?`,
        maxNudges,
        nudgeCutoff,
      )
      .toArray()
    let tick3Ok = 0
    let tick3Err = 0
    for (const row of overdueToNoShow) {
      const result = await this.runSweepStep("MarkNoShow", row.id as TicketId, () =>
        this.dispatch({
          type: "MarkNoShow",
          ticketId: row.id as TicketId,
          actor: "system",
        }),
      )
      if (result) tick3Ok += 1
      else tick3Err += 1
    }

    // Tick 4: Waiting (reservation lane) → Cancelled (appointment_lapsed).
    // ADR-0075 spec is `appointmentAt + grace < now`, i.e. `appointment_at
    // < cutoff`. Strict inequality so a ticket whose appointmentAt is
    // exactly `now - grace` is NOT lapsed in this tick (matches the
    // ADR's "more than grace seconds past" semantics).
    const lapsed = this.sql
      .exec(
        `SELECT id FROM tickets
         WHERE state = 'Waiting' AND lane = 'reservation'
           AND appointment_at IS NOT NULL AND appointment_at < ?`,
        appointmentCutoff,
      )
      .toArray()
    let tick4Ok = 0
    let tick4Err = 0
    for (const row of lapsed) {
      const result = await this.runSweepStep("LapseAppointment", row.id as TicketId, () =>
        this.dispatch({ type: "LapseAppointment", ticketId: row.id as TicketId }),
      )
      if (result) tick4Ok += 1
      else tick4Err += 1
    }

    console.warn(
      JSON.stringify({
        _tag: "AlarmSweep",
        code: "I_DO_ALARM",
        severity: "infrastructure",
        tick1: { candidates: calledStale.length, ok: tick1Ok, err: tick1Err },
        tick2: { candidates: overdueToNudge.length, ok: tick2Ok, err: tick2Err },
        tick3: { candidates: overdueToNoShow.length, ok: tick3Ok, err: tick3Err },
        tick4: { candidates: lapsed.length, ok: tick4Ok, err: tick4Err },
        ms: Date.now() - startedAt,
      }),
    )

    // Re-arm. The exact next firing depends on what's in the table now;
    // the cheap-and-correct policy is to wake again in
    // `min(nudgeInterval, overdueAfterCalled, appointmentGrace,
    // ALARM_FALLBACK_RE_ARM_SECONDS)` seconds. Each tick rechecks its
    // own predicate so a too-early wake is a no-op.
    const reArmSeconds = Math.min(
      overdueAfterCalled,
      nudgeInterval,
      appointmentGrace,
      ALARM_FALLBACK_RE_ARM_SECONDS,
    )
    await this.ctx.storage.setAlarm(Date.now() + reArmSeconds * 1000)
  }

  private pushEnabled(): boolean {
    return (
      this.env.VAPID_PUBLIC_KEY !== undefined &&
      this.env.VAPID_PRIVATE_KEY !== undefined &&
      this.env.VAPID_SUBJECT !== undefined
    )
  }

  /**
   * ADR-0073 — fan a single nudge out to every subscription
   * registered for the ticket. Per ADR-0074 the payload contains
   * only `displaySeq` + a short `kind` enum; no PII. On per-row
   * `subscriptionGone` we drop the dead subscription so the next
   * sweep does not pay the cost again.
   *
   * `nextNudgeCount` is the post-increment value the dispatched
   * `Nudge` use case will write to the event log (`current + 1`).
   * `kind` is derived from it: `overdue-final` at the cap so the
   * SW can render a stronger UX on the last warning, and
   * `overdue-{N}` for intermediate nudges (ADR-0074).
   *
   * Returns the delivery counts so the alarm Tick 2 caller can
   * decide whether the subsequent Nudged event should record
   * `channel: "push"` (≥ 1 delivered) or fall back to `"ws"` —
   * audit truth, not delivery intent.
   */
  private async fanOutPush(
    ticketId: TicketId,
    subs: readonly PushSubscription[],
    displaySeq: number,
    nextNudgeCount: number,
    maxNudges: number,
  ): Promise<{ readonly delivered: number; readonly total: number }> {
    const pub = this.env.VAPID_PUBLIC_KEY
    const priv = this.env.VAPID_PRIVATE_KEY
    const sub = this.env.VAPID_SUBJECT
    /* v8 ignore next 3 */
    if (pub === undefined || priv === undefined || sub === undefined) {
      return { delivered: 0, total: subs.length }
    }
    const kind = pushKindFor(nextNudgeCount, maxNudges)
    const payload = new TextEncoder().encode(JSON.stringify({ v: 1, kind, displaySeq }))
    let delivered = 0
    for (const s of subs) {
      let result: SendPushResult
      try {
        result = await sendPush({
          subscription: s,
          payload,
          vapidPublicKeyBase64Url: pub,
          vapidPrivateKeyBase64Url: priv,
          subject: sub,
        })
      } catch (err) {
        // sendPush is total; this branch is purely defensive against
        // import-time failures (e.g. WebCrypto missing in some
        // exotic runtime).
        console.error(
          JSON.stringify({
            _tag: "PushSendDefect",
            code: "I_PUSH_SEND_DEFECT",
            severity: "infrastructure",
            ticketId,
            message: err instanceof Error ? err.message : String(err),
          }),
        )
        continue
      }
      if (result.kind === "subscriptionGone") {
        this.sql.exec(
          "DELETE FROM push_subscriptions WHERE ticket_id = ? AND endpoint = ?",
          ticketId,
          s.endpoint,
        )
      }
      if (result.kind === "delivered") delivered += 1
      console.warn(
        JSON.stringify({
          _tag: "PushSend",
          code: "I_PUSH_SEND",
          severity: "infrastructure",
          ticketId,
          status: "status" in result ? result.status : undefined,
          outcome: result.kind,
        }),
      )
    }
    return { delivered, total: subs.length }
  }

  /**
   * Execute one sweep step and return whether it succeeded. Failures
   * are recorded as a structured log line (`I_DO_ALARM_STEP_ERROR`)
   * but never abort the surrounding sweep — a single misbehaving row
   * cannot block the rest of the queue.
   */
  private async runSweepStep(
    actionType: string,
    ticketId: TicketId,
    fire: () => Promise<QueueResult>,
  ): Promise<boolean> {
    try {
      const result = await fire()
      if (!result.ok) {
        console.error(
          JSON.stringify({
            _tag: "AlarmSweepStep",
            code: "I_DO_ALARM_STEP_ERROR",
            severity: "infrastructure",
            actionType,
            ticketId,
            errorTag: result.error._tag,
            errorCode: result.error.code,
          }),
        )
      }
      return result.ok
    } catch (err) {
      console.error(
        JSON.stringify({
          _tag: "AlarmSweepStep",
          code: "I_DO_ALARM_STEP_ERROR",
          severity: "infrastructure",
          actionType,
          ticketId,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
      return false
    }
  }
}
