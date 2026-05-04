import { Effect, Either, Layer } from "effect"
import { typeid } from "typeid-js"
import { ulid } from "ulidx"
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

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/**
 * Sample a uniformly-distributed `bigint` in `[0, BOOKING_CODE_KEYSPACE)`
 * from a fresh ULID. Folding 26 Crockford-base-32 chars into a 130-bit
 * accumulator and taking `mod KEYSPACE` (= 32^6 = 30 bits) is biased
 * negligibly: keyspace divides 2^130 evenly to within 2^-100.
 */
const sampleBookingCode = (): BookingCode => {
  let acc = 0n
  for (const c of ulid()) acc = (acc << 5n) | BigInt(CROCKFORD.indexOf(c))
  return Either.getOrThrow(encodeBookingCode(acc % BOOKING_CODE_KEYSPACE))
}

const make = <Id extends string>(prefix: string): Effect.Effect<Id> =>
  Effect.sync(() => typeid(prefix).toString() as unknown as Id)

/**
 * Production wiring of the {@link IdGenerator} port. Uses TypeID
 * (`<prefix>_<ULID>`) for entity ids and a uniform sample over
 * {@link BOOKING_CODE_KEYSPACE} for booking codes.
 */
export const UlidIdGeneratorLive = Layer.succeed(
  IdGenerator,
  IdGenerator.of({
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
    newBookingCode: Effect.sync(() => sampleBookingCode()),
  }),
)
