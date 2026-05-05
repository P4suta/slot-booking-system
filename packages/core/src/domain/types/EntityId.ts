import { Either, Schema } from "effect"
import { typeid } from "typeid-js"
import { type DomainError, InvalidEntityIdError } from "../errors/Errors.js"

/**
 * TypeID-shaped entity identifiers, branded so they cannot be mistakenly
 * substituted for one another. See ADR-0003.
 *
 * Internal representation is the canonical TypeID string `<prefix>_<ULID>`.
 * Each id is defined as an `Effect.Schema` so the type, runtime decoder,
 * and `Schema.is` predicate all derive from a single declaration.
 */

const makeIdSchema = <const Tag extends string>(prefix: string, tag: Tag) =>
  Schema.String.pipe(Schema.pattern(new RegExp(`^${prefix}_[0-9a-z]{26}$`)), Schema.brand(tag))

export const BookingIdSchema = makeIdSchema("book", "BookingId")
export const ServiceIdSchema = makeIdSchema("serv", "ServiceId")
export const ProviderIdSchema = makeIdSchema("prov", "ProviderId")
export const ResourceIdSchema = makeIdSchema("rsrc", "ResourceId")
export const ClosureIdSchema = makeIdSchema("clos", "ClosureId")
export const ProviderAbsenceIdSchema = makeIdSchema("absn", "ProviderAbsenceId")
export const BusinessHoursIdSchema = makeIdSchema("bhrs", "BusinessHoursId")
export const BookingEventIdSchema = makeIdSchema("evnt", "BookingEventId")
export const AuditLogIdSchema = makeIdSchema("audt", "AuditLogId")
export const IdempotencyKeyIdSchema = makeIdSchema("idem", "IdempotencyKeyId")
export const StaffIdSchema = makeIdSchema("staf", "StaffId")

export type BookingId = Schema.Schema.Type<typeof BookingIdSchema>
export type ServiceId = Schema.Schema.Type<typeof ServiceIdSchema>
export type ProviderId = Schema.Schema.Type<typeof ProviderIdSchema>
export type ResourceId = Schema.Schema.Type<typeof ResourceIdSchema>
export type ClosureId = Schema.Schema.Type<typeof ClosureIdSchema>
export type ProviderAbsenceId = Schema.Schema.Type<typeof ProviderAbsenceIdSchema>
export type BusinessHoursId = Schema.Schema.Type<typeof BusinessHoursIdSchema>
export type BookingEventId = Schema.Schema.Type<typeof BookingEventIdSchema>
export type AuditLogId = Schema.Schema.Type<typeof AuditLogIdSchema>
export type IdempotencyKeyId = Schema.Schema.Type<typeof IdempotencyKeyIdSchema>
export type StaffId = Schema.Schema.Type<typeof StaffIdSchema>

/** Stable union of every TypeID prefix the system mints. */
export type EntityPrefix =
  | "book"
  | "serv"
  | "prov"
  | "rsrc"
  | "clos"
  | "absn"
  | "bhrs"
  | "evnt"
  | "audt"
  | "idem"
  | "staf"

const makeParser =
  <Id>(prefix: EntityPrefix, schema: Schema.Schema<Id, string>) =>
  (s: string): Either.Either<Id, DomainError> =>
    Either.mapLeft(
      Schema.decodeUnknownEither(schema)(s),
      () => new InvalidEntityIdError({ expectedPrefix: `${prefix}_`, received: s }),
    )

export const parseBookingId = makeParser("book", BookingIdSchema)
export const parseServiceId = makeParser("serv", ServiceIdSchema)
export const parseProviderId = makeParser("prov", ProviderIdSchema)
export const parseResourceId = makeParser("rsrc", ResourceIdSchema)
export const parseClosureId = makeParser("clos", ClosureIdSchema)
export const parseProviderAbsenceId = makeParser("absn", ProviderAbsenceIdSchema)
export const parseBusinessHoursId = makeParser("bhrs", BusinessHoursIdSchema)
export const parseBookingEventId = makeParser("evnt", BookingEventIdSchema)
export const parseAuditLogId = makeParser("audt", AuditLogIdSchema)
export const parseIdempotencyKeyId = makeParser("idem", IdempotencyKeyIdSchema)
export const parseStaffId = makeParser("staf", StaffIdSchema)

/**
 * TypeID-prefixed string generator. The return type is fixed at the
 * callsite (`newBookingId: () => BookingId = ...`) rather than via
 * a type parameter, because a single-use type parameter triggers
 * `@typescript-eslint/no-unnecessary-type-parameters`.
 */
const generator = (prefix: EntityPrefix) => (): string => typeid(prefix).toString()

export const newBookingId: () => BookingId = generator("book") as () => BookingId
export const newServiceId: () => ServiceId = generator("serv") as () => ServiceId
export const newProviderId: () => ProviderId = generator("prov") as () => ProviderId
export const newResourceId: () => ResourceId = generator("rsrc") as () => ResourceId
export const newClosureId: () => ClosureId = generator("clos") as () => ClosureId
export const newProviderAbsenceId: () => ProviderAbsenceId = generator(
  "absn",
) as () => ProviderAbsenceId
export const newBusinessHoursId: () => BusinessHoursId = generator("bhrs") as () => BusinessHoursId
export const newBookingEventId: () => BookingEventId = generator("evnt") as () => BookingEventId
export const newAuditLogId: () => AuditLogId = generator("audt") as () => AuditLogId
export const newIdempotencyKeyId: () => IdempotencyKeyId = generator(
  "idem",
) as () => IdempotencyKeyId
export const newStaffId: () => StaffId = generator("staf") as () => StaffId
