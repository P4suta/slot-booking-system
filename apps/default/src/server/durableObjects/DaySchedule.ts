import { DurableObject } from "cloudflare:workers"
import type { DomainError, ErrorSeverity } from "@booking/core"
import {
  BloomBookingCodeIndexLive,
  BookingCodeIndex,
  CancelBooking,
  ConfirmBooking,
  codeOf,
  HoldSlot,
  RescheduleBooking,
  SilentLoggerLive,
  SystemClockLive,
  severityOf,
  UlidIdGeneratorLive,
} from "@booking/core"
import { Effect, Either, Layer, Schema } from "effect"
import { upsertBookingsToD1 } from "../adapters/D1BookingMirror.js"
import {
  type DurableStorage,
  loadAllBookings,
  loadAllEvents,
  makeDurableObjectEventSourcedRepository,
} from "../adapters/DurableObjectEventSourcedRepositoryLive.js"

/**
 * Per-day actor (ADR-0005). One DO instance per `(deployment, date)`
 * tuple. Concurrency through the actor model — every fetch is
 * processed serially by the runtime, so no two `HoldSlot` calls for
 * the same day can interleave at the application layer.
 *
 * **Persistence layout** — the DO's storage holds:
 *   - `b:<bookingId>` → encoded `Booking` (read-side projection)
 *   - `c:<bookingCode>` → `bookingId` (reverse index)
 *   - `e:<bookingId>:<seq>` → encoded `BookingEvent` (truth)
 *   - `s:<bookingId>` → current sequence number
 *
 * **Cold start** — on the first fetch after eviction, `ensureWarmed`
 * walks the existing booking-code keys and re-warms the in-process
 * `BookingCodeIndex` Bloom filter.
 *
 * **Hold expiry** — `alarm()` finds every `Held` booking past its TTL
 * and emits a `Cancel` command (with `cancelledBy = "system"` per the
 * `Expire` command path inside `apply`). Outbox sync to D1 will
 * piggyback on the same alarm tick once the relay is wired in.
 */

const Op = Schema.Union(
  Schema.Struct({ type: Schema.Literal("hold"), payload: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("confirm"), payload: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("cancel"), payload: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("reschedule"), payload: Schema.Unknown }),
)
type Op = Schema.Schema.Type<typeof Op>

type Env = {
  DB: D1Database
}

export class DaySchedule extends DurableObject<Env> {
  private warmed = false

  override async fetch(request: Request): Promise<Response> {
    await this.ensureWarmed()
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "INVALID_JSON", "request body is not valid JSON")
    }
    const opResult = Schema.decodeUnknownEither(Op)(body)
    if (opResult._tag === "Left") {
      return jsonError(400, "INVALID_OPERATION", "unrecognised operation tag")
    }
    return this.runOp(opResult.right)
  }

  override async alarm(): Promise<void> {
    await this.ensureWarmed()
    const storage = this.ctx.storage as unknown as DurableStorage
    await this.expireStaleHolds(storage)
    await this.drainOutboxToD1(storage)
  }

  private async expireStaleHolds(storage: DurableStorage): Promise<void> {
    const all = await loadAllBookings(storage)
    const now = Date.now()
    const toExpire = all.filter((b) => b.state === "Held" && b.expiresAt.epochMilliseconds <= now)
    if (toExpire.length === 0) return
    const layer = this.layer(storage)
    await Promise.all(
      toExpire.map((b) =>
        Effect.runPromise(
          CancelBooking({
            code: b.code,
            phoneLast4: b.phoneLast4,
            reason: "hold expired",
          }).pipe(
            Effect.provide(layer),
            Effect.catchAll(() => Effect.void),
          ),
        ),
      ),
    )
  }

  /**
   * Outbox draining (ADR-0006). The DO's local SQLite is the truth for
   * in-flight days; D1 is the long-retention read projection.
   *
   * On each alarm tick we:
   *   1. snapshot every booking from the DO's local store
   *   2. upsert each into D1 via {@link upsertBookingsToD1}
   *
   * `INSERT … ON CONFLICT DO UPDATE` gives us idempotency: re-applying
   * the same snapshot is a no-op, so the relay is at-least-once safe
   * even if the alarm fires twice or wrangler restarts the worker
   * mid-flush.
   *
   * Phase 0.6 ships the snapshot-based projector; the per-event log
   * (`loadAllEvents`) is loaded only for the future event-sourcing
   * relay (T1-D), where each event will additionally be appended to
   * D1's `booking_events` table for the audit trail.
   */
  private async drainOutboxToD1(storage: DurableStorage): Promise<void> {
    const events = await loadAllEvents(storage)
    if (events.length === 0) return
    const bookings = await loadAllBookings(storage)
    await Effect.runPromise(upsertBookingsToD1(this.env.DB, bookings))
  }

  private async runOp(op: Op): Promise<Response> {
    const storage = this.ctx.storage as unknown as DurableStorage
    const layer = this.layer(storage)

    const program: Effect.Effect<unknown, DomainError> = ((): Effect.Effect<
      unknown,
      DomainError
    > => {
      switch (op.type) {
        case "hold":
          return HoldSlot(op.payload as Parameters<typeof HoldSlot>[0]).pipe(Effect.provide(layer))
        case "confirm":
          return ConfirmBooking(op.payload as Parameters<typeof ConfirmBooking>[0]).pipe(
            Effect.provide(layer),
          )
        case "cancel":
          return CancelBooking(op.payload as Parameters<typeof CancelBooking>[0]).pipe(
            Effect.provide(layer),
          )
        case "reschedule":
          return RescheduleBooking(op.payload as Parameters<typeof RescheduleBooking>[0]).pipe(
            Effect.provide(layer),
          )
      }
    })()

    const result = await Effect.runPromise(Effect.either(program))
    if (Either.isRight(result)) {
      return new Response(JSON.stringify({ ok: true, result: result.right }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    }
    const e = result.left
    return jsonError(domainErrorToStatus(e), codeOf(e), e._tag, severityOf(e))
  }

  private async ensureWarmed(): Promise<void> {
    if (this.warmed) return
    const storage = this.ctx.storage as unknown as DurableStorage
    const all = await loadAllBookings(storage)
    if (all.length > 0) {
      const layer = this.layer(storage)
      await Effect.runPromise(
        Effect.gen(function* () {
          const idx = yield* BookingCodeIndex
          for (const b of all) yield* idx.add(b.code)
        }).pipe(Effect.provide(layer)),
      )
    }
    this.warmed = true
  }

  private layer(storage: DurableStorage) {
    return Layer.mergeAll(
      makeDurableObjectEventSourcedRepository(storage),
      BloomBookingCodeIndexLive,
      SystemClockLive,
      UlidIdGeneratorLive,
      SilentLoggerLive,
    )
  }
}

const jsonError = (
  status: number,
  code: string,
  tag: string,
  severity: ErrorSeverity = "domain",
): Response =>
  new Response(JSON.stringify({ ok: false, error: { _tag: tag, code, severity } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

/**
 * HTTP status mapping for domain errors. Validation failures → 400,
 * not-found / phone-mismatch → 404 (deliberately conflated to avoid
 * leaking which half of the credential pair was wrong), terminal
 * state / availability → 409.
 */
const domainErrorToStatus = (e: DomainError): number => {
  switch (e._tag) {
    case "BookingNotFound":
    case "PhoneMismatch":
    case "AggregateNotFound":
      return 404
    case "AlreadyCancelled":
    case "AlreadyCompleted":
    case "AlreadyNoShow":
    case "InvalidStateTransition":
    case "SlotUnavailable":
    case "SlotExpired":
    case "OutsideBusinessHours":
    case "ServiceDisabled":
    case "ProviderUnavailable":
    case "ResourceUnavailable":
    case "Concurrency":
      return 409
    case "Storage":
      return 500
    default:
      return 400
  }
}
