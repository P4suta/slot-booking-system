import { DurableObject } from "cloudflare:workers"
import {
  type BusinessTimeZone,
  ExpireBooking,
  isHeld,
  parseBusinessTimeZone,
  StorageError,
  SystemClockLive,
  UlidIdGeneratorLive,
} from "@booking/core"
import { Effect, Layer, Result } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import {
  type DurableObjectStorageLike,
  loadAllBookings,
  makeDurableObjectEventSourcedRepository,
} from "../adapters/DurableObjectEventSourcedRepositoryLive.js"
import { WorkersLoggerLive } from "../adapters/WorkersLoggerLive.js"
import { DayScheduleHandlersLayer } from "./effectRpc/handlers.js"
import { DayScheduleRouter } from "./effectRpc/router.js"
import { drainOutbox, nextOutboxAttemptAt } from "./relay.js"
import { ensureDurableObjectSchema } from "./schema.js"

/**
 * Per-day actor (ADR-0005). One DO instance per `(deployment, date)`
 * tuple. Concurrency through the actor model — every RPC dispatch is
 * processed serially by the runtime, so no two `HoldSlot` requests for
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
 * **RPC surface** (Phase 2.8 / BI-4) — a single `dispatch(envelope)`
 * method consumes a `FromClientEncoded` request envelope tagged with
 * the RPC name (`HoldSlot` / `ConfirmBooking` / `CancelBooking` /
 * `RescheduleBooking`) and returns the matching `FromServerEncoded`
 * response (`Exit` for normal flow, `Defect` for crashes). Both
 * shapes are pure JSON, so they survive Cloudflare's structured-clone
 * envelope unchanged. The typed `effect/unstable/rpc` client on the resolver
 * side (`makeDayScheduleClient`) hides the envelope plumbing —
 * resolvers see strongly-typed `client.HoldSlot(payload)` returning
 * `Effect<Result, DomainError>` instead of the legacy
 * `Result<EncodedResult, EncodedDomainError>` cast pattern.
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
  DEPLOYMENT_TIMEZONE: string
}

export class DaySchedule extends DurableObject<Env> {
  /**
   * Resolved deployment timezone. Parsed once at constructor time
   * inside `blockConcurrencyWhile` — the value cannot change for the
   * lifetime of this DO instance, so re-parsing on every `dispatch`
   * was wasted CPU and a lurking allocation per RPC. `parseError`
   * holds the failure if `DEPLOYMENT_TIMEZONE` is invalid; the
   * `deploymentTimeZone` Effect surfaces it through the same
   * `StorageError` channel that the resolver already handles.
   */
  private timeZone: BusinessTimeZone | null = null
  private timeZoneError: StorageError | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(() => {
      ensureDurableObjectSchema(ctx.storage.sql)
      const parsed = parseBusinessTimeZone(env.DEPLOYMENT_TIMEZONE)
      Result.match(parsed, {
        onSuccess: (tz) => {
          this.timeZone = tz
        },
        onFailure: () => {
          this.timeZoneError = new StorageError({
            reason: `invalid DEPLOYMENT_TIMEZONE: ${env.DEPLOYMENT_TIMEZONE}`,
          })
        },
      })
      return Promise.resolve()
    })
  }

  /**
   * Phase 2.8 / BI-4 — `effect/unstable/rpc` typed RPC entry point.
   *
   * Single multiplexed dispatch: callers send a `FromClientEncoded`
   * envelope tagged with the RPC name; the response comes back as a
   * single `FromServerEncoded` envelope (typically `ResponseExitEncoded`
   * for request/response RPC). Both shapes are pure JSON so they
   * traverse Cloudflare's `structuredClone` unchanged.
   *
   * Internally we spin up `RpcServer.makeNoSerialization` per request,
   * push the inbound envelope through `server.write(0, msg)`, and
   * collect the matching response in `onFromServer`. The single-shot
   * lifecycle matches DO RPC's request/response shape — no daemon /
   * mailbox coordination required.
   */
  async dispatch(envelope: unknown): Promise<unknown> {
    const tz = await Effect.runPromise(this.deploymentTimeZone)
    const storage = this.ctx.storage as unknown as DurableObjectStorageLike
    const handlerLayer = DayScheduleHandlersLayer(tz, this.layer(storage))
    const responses: unknown[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* RpcServer.makeNoSerialization(DayScheduleRouter, {
          onFromServer: (response) =>
            Effect.sync(() => {
              responses.push(response)
            }),
        })
        yield* server.write(0, envelope as never)
      }).pipe(Effect.provide(handlerLayer), Effect.scoped),
    )
    return responses.find(
      (r): r is { _tag: "Exit" | "Defect" } =>
        typeof r === "object" &&
        r !== null &&
        "_tag" in r &&
        (r._tag === "Exit" || r._tag === "Defect"),
    )
  }

  /**
   * Effect view of the cached deployment timezone. The parse happened
   * once in the constructor; subsequent reads short-circuit to the
   * pre-resolved value or its parse failure.
   */
  private readonly deploymentTimeZone: Effect.Effect<BusinessTimeZone, StorageError> =
    Effect.suspend(() =>
      this.timeZoneError !== null
        ? Effect.fail(this.timeZoneError)
        : // biome-ignore lint/style/noNonNullAssertion: blockConcurrencyWhile sets one of the two before any dispatch runs
          Effect.succeed(this.timeZone!),
    )

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
            Effect.catch(() => Effect.void),
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
