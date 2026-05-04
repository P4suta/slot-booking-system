import { Effect, Either, Layer, Ref } from "effect"
import { IdGenerator } from "../../application/ports/IdGenerator.js"
import type {
  AuditLogId,
  BookingEventId,
  BookingId,
  BusinessHoursId,
  ClosureId,
  IdempotencyKeyId,
  ProviderAbsenceId,
  ProviderId,
  ResourceId,
  ServiceId,
} from "../../domain/types/EntityId.js"
import {
  BOOKING_CODE_KEYSPACE,
  type BookingCode,
  encodeBookingCode,
} from "../../domain/value-objects/BookingCode.js"

const CROCKFORD_LOWER = "0123456789abcdefghjkmnpqrstvwxyz"

/**
 * Render a non-negative `bigint` as a fixed-width 26-char ULID body
 * using Crockford Base32 in **lower case** to match typeid-js's
 * canonical surface (`<prefix>_<26 lowercase chars>`). Tail-padded with
 * `'0'` so the leading bytes deterministically encode the counter.
 */
const ulidLikeBody = (counter: bigint): string => {
  let v = counter
  const buf: string[] = []
  for (let i = 0; i < 26; i++) {
    buf.push(CROCKFORD_LOWER.charAt(Number(v & 31n)))
    v >>= 5n
  }
  return buf.reverse().join("")
}

/**
 * Build a {@link IdGenerator} layer whose every method draws from a
 * shared, atomically-incremented counter seeded by `seed` (default `0`).
 * Across one test run the same call sequence always produces the same
 * id sequence, eliminating the wall-clock leak that ULID-based
 * generators introduce.
 */
export const makeDeterministicIdGenerator = (seed: bigint = 0n): Layer.Layer<IdGenerator> =>
  Layer.effect(
    IdGenerator,
    Effect.gen(function* () {
      const counter = yield* Ref.make(seed)
      const next = Ref.updateAndGet(counter, (n) => n + 1n)
      const make = <Id extends string>(prefix: string): Effect.Effect<Id> =>
        Effect.map(next, (n) => `${prefix}_${ulidLikeBody(n)}` as unknown as Id)
      return IdGenerator.of({
        newBookingId: make<BookingId>("book"),
        newServiceId: make<ServiceId>("serv"),
        newProviderId: make<ProviderId>("prov"),
        newResourceId: make<ResourceId>("rsrc"),
        newClosureId: make<ClosureId>("clos"),
        newProviderAbsenceId: make<ProviderAbsenceId>("absn"),
        newBusinessHoursId: make<BusinessHoursId>("bhrs"),
        newBookingEventId: make<BookingEventId>("evnt"),
        newAuditLogId: make<AuditLogId>("audt"),
        newIdempotencyKeyId: make<IdempotencyKeyId>("idem"),
        newBookingCode: Effect.map(
          next,
          (n): BookingCode =>
            Either.getOrThrow(
              encodeBookingCode(
                ((n % BOOKING_CODE_KEYSPACE) + BOOKING_CODE_KEYSPACE) % BOOKING_CODE_KEYSPACE,
              ),
            ),
        ),
      })
    }),
  )

/**
 * Convenience layer for tests that don't need to specify a seed.
 * Equivalent to `makeDeterministicIdGenerator(0n)`.
 */
export const DeterministicIdGeneratorLive = makeDeterministicIdGenerator()
