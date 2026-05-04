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

/** Stable mapping from TypeID prefix to brand-name string. */
const PREFIXES = {
  book: "BookingId",
  serv: "ServiceId",
  prov: "ProviderId",
  rsrc: "ResourceId",
  clos: "ClosureId",
  absn: "ProviderAbsenceId",
  bhrs: "BusinessHoursId",
  evnt: "BookingEventId",
  audt: "AuditLogId",
  idem: "IdempotencyKeyId",
} as const

export type EntityPrefix = keyof typeof PREFIXES

const makeParser =
  <Id, P extends string>(prefix: P, schema: Schema.Schema<Id, string>) =>
  (s: string): Either.Either<Id, DomainError> => {
    const decode = Schema.decodeUnknownEither(schema)
    return Either.mapLeft(
      decode(s),
      () => new InvalidEntityIdError({ expectedPrefix: `${prefix}_`, received: s }),
    )
  }

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

const generator =
  <Id extends string>(prefix: EntityPrefix) =>
  (): Id =>
    typeid(prefix).toString() as unknown as Id

export const newBookingId = generator<BookingId>("book")
export const newServiceId = generator<ServiceId>("serv")
export const newProviderId = generator<ProviderId>("prov")
export const newResourceId = generator<ResourceId>("rsrc")
export const newClosureId = generator<ClosureId>("clos")
export const newProviderAbsenceId = generator<ProviderAbsenceId>("absn")
export const newBusinessHoursId = generator<BusinessHoursId>("bhrs")
export const newBookingEventId = generator<BookingEventId>("evnt")
export const newAuditLogId = generator<AuditLogId>("audt")
export const newIdempotencyKeyId = generator<IdempotencyKeyId>("idem")
