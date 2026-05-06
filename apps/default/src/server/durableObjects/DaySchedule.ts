import { DurableObject } from "cloudflare:workers"
import {
  type BookingEventSourcedRepository,
  CancelBooking,
  type CancelBookingInput,
  type CancelBookingResult,
  type Clock,
  ConfirmBooking,
  type ConfirmBookingInput,
  type ConfirmBookingResult,
  codeOf,
  type DomainError,
  type ErrorSeverity,
  ExpireBooking,
  HoldSlot,
  type HoldSlotInput,
  type HoldSlotResult,
  type IdGenerator,
  isHeld,
  type Logger,
  mintTraceId,
  RescheduleBooking,
  type RescheduleBookingInput,
  type RescheduleBookingResult,
  SystemClockLive,
  severityOf,
  UlidIdGeneratorLive,
  withTraceId,
} from "@booking/core"
import { Effect, Either, Layer, Schema } from "effect"
import {
  type DurableObjectStorageLike,
  loadAllBookings,
  makeDurableObjectEventSourcedRepository,
} from "../adapters/DurableObjectEventSourcedRepositoryLive.js"
import { WorkersLoggerLive } from "../adapters/WorkersLoggerLive.js"
import { drainOutbox, nextOutboxAttemptAt } from "./relay.js"
import { ensureDurableObjectSchema } from "./schema.js"

/**
 * Per-day actor (ADR-0005). One DO instance per `(deployment, date)`
 * tuple. Concurrency through the actor model — every RPC method call
 * is processed serially by the runtime, so no two `holdSlot` calls for
 * the same day can interleave at the application layer.
 *
 * **Persistence layout** — DO local SQLite (ADR-0028) holds:
 *   - `bookings` — read-side projection, one row per aggregate
 *   - `booking_events` — append-only truth log, bitemporal + versioned
 *   - `outbox` — pending DO → D1 relay rows
 *   - `outbox_dead` — rows past retry budget
 *
 * Schema is applied idempotently from the constructor via
 * `ensureDurableObjectSchema(ctx.storage.sql)` under
 * `ctx.blockConcurrencyWhile`, so every subsequent fetch sees a
 * fully-migrated schema.
 *
 * **RPC surface** (ADR-0030 / 2026 mainstream): each booking mutation
 * is an `async` method that returns `Either<EncodedDomainError,
 * EncodedResult>`. The Either values cross the structured-clone
 * boundary as plain JSON; the caller (GraphQL resolver) narrows on
 * `_tag` and either re-encodes the success or maps the failure to a
 * GraphQL error. Throwing across the RPC boundary is **avoided** —
 * Cloudflare strips custom Error subclass fields, which would erase
 * the discriminated union (ADR-0030).
 *
 * **Cold start** — none required. The `(code → id)` lookup is a SQL
 * query against `bookings.code` (unique index), exact on every cold
 * or warm path. Phase 0.6 dropped the bloom filter pre-screen.
 *
 * **Hold expiry** — `alarm()` finds every `Held` booking past its TTL
 * and emits a `Cancel` command; the outbox relay piggybacks on the
 * same alarm tick. `setAlarm()` schedules the next fire to the
 * minimum of (earliest hold expiry, earliest outbox retry, +60s).
 */

type Env = {
  DB: D1Database
}

/* ----- Encoded result shapes returned across the RPC boundary ----- */

type EncodedDomainError = {
  readonly _tag: string
  readonly code: string
  readonly severity: ErrorSeverity
}

type EncodedHoldResult = Schema.Schema.Encoded<typeof BookingResultSchema>
type EncodedConfirmResult = Schema.Schema.Encoded<typeof BookingResultSchema>
type EncodedCancelResult = Schema.Schema.Encoded<typeof BookingResultSchema>
type EncodedRescheduleResult = Schema.Schema.Encoded<typeof BookingResultSchema>

/* Lightweight caller-facing result schema — the DO returns the
 * minimum fields the GraphQL surface needs. The full Booking + Event
 * remain inside the DO's storage; callers query separately via D1. */
const BookingResultSchema = Schema.Struct({
  bookingId: Schema.String,
  state: Schema.Literal("Held", "Confirmed", "Cancelled", "Completed", "NoShow"),
  eventType: Schema.Literal("Held", "Confirmed", "Cancelled", "Rescheduled", "Completed", "NoShow"),
})
type BookingResult = Schema.Schema.Type<typeof BookingResultSchema>

const encodeResult = Schema.encodeSync(BookingResultSchema)

const encodeDomainError = (e: DomainError): EncodedDomainError => ({
  _tag: e._tag,
  code: codeOf(e),
  severity: severityOf(e),
})

const projectResult = (
  r: HoldSlotResult | ConfirmBookingResult | CancelBookingResult | RescheduleBookingResult,
): BookingResult => ({
  bookingId: r.booking.id,
  state: r.booking.state,
  eventType: r.event.type,
})

export class DaySchedule extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(() => {
      ensureDurableObjectSchema(ctx.storage.sql)
      return Promise.resolve()
    })
  }

  /* -------------------------------------------------------------------- */
  /* RPC methods — caller invokes via `stub.<name>(input)`                */
  /* -------------------------------------------------------------------- */

  async holdSlot(
    input: HoldSlotInput,
  ): Promise<Either.Either<EncodedHoldResult, EncodedDomainError>> {
    return this.runUseCase(HoldSlot(input))
  }

  async confirmBooking(
    input: ConfirmBookingInput,
  ): Promise<Either.Either<EncodedConfirmResult, EncodedDomainError>> {
    return this.runUseCase(ConfirmBooking(input))
  }

  async cancelBooking(
    input: CancelBookingInput,
  ): Promise<Either.Either<EncodedCancelResult, EncodedDomainError>> {
    return this.runUseCase(CancelBooking(input))
  }

  async rescheduleBooking(
    input: RescheduleBookingInput,
  ): Promise<Either.Either<EncodedRescheduleResult, EncodedDomainError>> {
    return this.runUseCase(RescheduleBooking(input))
  }

  /* -------------------------------------------------------------------- */
  /* System handlers                                                      */
  /* -------------------------------------------------------------------- */

  override async alarm(): Promise<void> {
    const storage = this.ctx.storage as unknown as DurableObjectStorageLike
    await this.expireStaleHolds(storage)
    await drainOutbox(storage, this.env.DB)
    /* Reschedule the next alarm: min(earliest outbox retry, earliest hold expiry, +60s). */
    const nextOutbox = nextOutboxAttemptAt(storage)
    const all = loadAllBookings(storage)
    const earliestHoldExpiry = all
      .filter(isHeld)
      .map((b) => b.expiresAt.epochMilliseconds)
      .reduce<number | null>((min, t) => (min === null || t < min ? t : min), null)
    const candidates: number[] = [Date.now() + 60_000]
    if (nextOutbox !== null) candidates.push(Date.parse(nextOutbox))
    if (earliestHoldExpiry !== null) candidates.push(earliestHoldExpiry)
    const nextAlarm = Math.min(...candidates)
    await this.ctx.storage.setAlarm(nextAlarm)
  }

  /* -------------------------------------------------------------------- */
  /* Private helpers                                                      */
  /* -------------------------------------------------------------------- */

  private async runUseCase<
    R extends HoldSlotResult | ConfirmBookingResult | CancelBookingResult | RescheduleBookingResult,
  >(
    program: Effect.Effect<
      R,
      DomainError,
      BookingEventSourcedRepository | Clock | IdGenerator | Logger
    >,
  ): Promise<Either.Either<EncodedHoldResult, EncodedDomainError>> {
    const storage = this.ctx.storage as unknown as DurableObjectStorageLike
    const layer = this.layer(storage)
    // Mint a fresh request-scoped trace id and pin it on the
    // `CurrentTraceId` FiberRef so every log / audit call beneath
    // this RPC entry shares the same correlation key.
    const traceId = mintTraceId()
    const wrapped = withTraceId(traceId, program)
    const result = await Effect.runPromise(Effect.either(wrapped.pipe(Effect.provide(layer))))
    if (Either.isRight(result)) {
      return Either.right(encodeResult(projectResult(result.right)))
    }
    return Either.left(encodeDomainError(result.left))
  }

  private async expireStaleHolds(storage: DurableObjectStorageLike): Promise<void> {
    const all = loadAllBookings(storage)
    const now = Date.now()
    const toExpire = all.filter((b) => isHeld(b) && b.expiresAt.epochMilliseconds <= now)
    if (toExpire.length === 0) return
    const layer = this.layer(storage)
    await Promise.all(
      toExpire.map((b) =>
        Effect.runPromise(
          ExpireBooking({ bookingId: b.id }).pipe(
            Effect.provide(layer),
            Effect.catchAll(() => Effect.void),
          ),
        ),
      ),
    )
  }

  private layer(storage: DurableObjectStorageLike) {
    return Layer.mergeAll(
      makeDurableObjectEventSourcedRepository(storage),
      SystemClockLive,
      UlidIdGeneratorLive,
      WorkersLoggerLive,
    )
  }
}
