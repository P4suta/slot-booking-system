import { DurableObject } from "cloudflare:workers"
import type { DomainError, ErrorSeverity } from "@booking/core"
import {
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
import {
  type DurableObjectStorageLike,
  loadAllBookings,
  makeDurableObjectEventSourcedRepository,
} from "../adapters/DurableObjectEventSourcedRepositoryLive.js"
import { drainOutbox, nextOutboxAttemptAt } from "./relay.js"
import { ensureDurableObjectSchema } from "./schema.js"

/**
 * Per-day actor (ADR-0005). One DO instance per `(deployment, date)`
 * tuple. Concurrency through the actor model — every fetch is
 * processed serially by the runtime, so no two `HoldSlot` calls for
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
 * **Cold start** — none required. The `(code → id)` lookup is a SQL
 * query against `bookings.code` (unique index), exact on every cold
 * or warm path. Phase 0.6 dropped the bloom filter pre-screen.
 *
 * **Hold expiry** — `alarm()` finds every `Held` booking past its TTL
 * and emits a `Cancel` command. Outbox relay piggybacks on the same
 * alarm tick.
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(() => {
      ensureDurableObjectSchema(ctx.storage.sql)
      return Promise.resolve()
    })
  }

  override async fetch(request: Request): Promise<Response> {
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
    const storage = this.ctx.storage as unknown as DurableObjectStorageLike
    await this.expireStaleHolds(storage)
    await drainOutbox(storage, this.env.DB)
    /* Reschedule the next alarm: min(earliest outbox retry, earliest hold expiry, +60s). */
    const nextOutbox = nextOutboxAttemptAt(storage)
    const all = loadAllBookings(storage)
    const earliestHoldExpiry = all
      .filter((b) => b.state === "Held")
      .map((b) => b.expiresAt.epochMilliseconds)
      .reduce<number | null>((min, t) => (min === null || t < min ? t : min), null)
    const candidates: number[] = [Date.now() + 60_000]
    if (nextOutbox !== null) candidates.push(Date.parse(nextOutbox))
    if (earliestHoldExpiry !== null) candidates.push(earliestHoldExpiry)
    const nextAlarm = Math.min(...candidates)
    await this.ctx.storage.setAlarm(nextAlarm)
  }

  private async expireStaleHolds(storage: DurableObjectStorageLike): Promise<void> {
    const all = loadAllBookings(storage)
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

  private async runOp(op: Op): Promise<Response> {
    const storage = this.ctx.storage as unknown as DurableObjectStorageLike
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

  private layer(storage: DurableObjectStorageLike) {
    return Layer.mergeAll(
      makeDurableObjectEventSourcedRepository(storage),
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
 * state / availability → 409, infra storage → 500.
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
