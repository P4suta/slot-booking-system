import { type Brand, Result, Schema } from "effect"
import { typeid } from "typeid-js"
import { type DomainError, InvalidEntityIdError } from "../errors/Errors.js"

/**
 * TypeID-shaped entity identifiers, branded so they cannot be mistakenly
 * substituted for one another. See ADR-0003.
 *
 * Internal representation is the canonical TypeID string `<prefix>_<ULID>`.
 * Each id is materialised as an `Effect.Schema` so the type, runtime
 * decoder, and `Schema.is` predicate all derive from a single declaration.
 *
 * Higher-kinded brand: every entity kind is one row in the
 * {@link ENTITY_KIND_TAG} map below; `Id<"book">` is `BookingId`,
 * `Id<"serv">` is `ServiceId`, etc. Adding a new kind is one row plus
 * the four legacy aliases (kept so existing call-sites keep compiling).
 */

const ENTITY_KIND_TAG = {
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
  staf: "StaffId",
} as const satisfies Record<string, string>

/** Stable union of every TypeID prefix the system mints. */
export type EntityKind = keyof typeof ENTITY_KIND_TAG

/** Legacy alias for {@link EntityKind}. */
export type EntityPrefix = EntityKind

type EntityTag<E extends EntityKind> = (typeof ENTITY_KIND_TAG)[E]

/**
 * Higher-kinded brand. `Id<"book">` ≡ `string & Brand<"BookingId">`.
 * Two distinct kinds yield mutually-disjoint branded types, even though
 * the runtime representation is plain `string` for both.
 */
export type Id<E extends EntityKind> = string & Brand.Brand<EntityTag<E>>

/** Tuple enumerating every {@link EntityKind}. Useful for property tests. */
export const ALL_ENTITY_KINDS = [
  "book",
  "serv",
  "prov",
  "rsrc",
  "clos",
  "absn",
  "bhrs",
  "evnt",
  "audt",
  "idem",
  "staf",
] as const satisfies readonly EntityKind[]

/* -------------------------------------------------------------------------- */
/* Generic schema / parser / generator                                         */
/* -------------------------------------------------------------------------- */

const idSchema = <E extends EntityKind>(prefix: E) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^${prefix}_[0-9a-z]{26}$`))).pipe(
    Schema.brand(ENTITY_KIND_TAG[prefix]),
  )

/**
 * Generic Result-flavoured parser for any {@link EntityKind}.
 * `parseId("book")` is `parseBookingId`, `parseId("serv")` is
 * `parseServiceId`, and so on.
 */
export const parseId =
  <E extends EntityKind>(prefix: E) =>
  (s: string): Result.Result<Id<E>, DomainError> =>
    Result.mapError(
      Schema.decodeUnknownResult(idSchema(prefix))(s),
      () => new InvalidEntityIdError({ expectedPrefix: `${prefix}_`, received: s }),
    ) as unknown as Result.Result<Id<E>, DomainError>

/**
 * Generic generator. Produces a fresh canonical TypeID for the given
 * prefix. The single-cast `as Id<E>` is justified: the Schema check
 * passes by construction (typeid-js emits the canonical
 * `<prefix>_<26 lower-base32>` shape).
 */
export const newId =
  <E extends EntityKind>(prefix: E) =>
  (): Id<E> =>
    typeid(prefix).toString() as unknown as Id<E>

/* -------------------------------------------------------------------------- */
/* Per-kind exports (legacy named aliases, derived from the generic core)      */
/* -------------------------------------------------------------------------- */

export const BookingIdSchema = idSchema("book")
export const ServiceIdSchema = idSchema("serv")
export const ProviderIdSchema = idSchema("prov")
export const ResourceIdSchema = idSchema("rsrc")
export const ClosureIdSchema = idSchema("clos")
export const ProviderAbsenceIdSchema = idSchema("absn")
export const BusinessHoursIdSchema = idSchema("bhrs")
export const BookingEventIdSchema = idSchema("evnt")
export const AuditLogIdSchema = idSchema("audt")
export const IdempotencyKeyIdSchema = idSchema("idem")
export const StaffIdSchema = idSchema("staf")

export type BookingId = Id<"book">
export type ServiceId = Id<"serv">
export type ProviderId = Id<"prov">
export type ResourceId = Id<"rsrc">
export type ClosureId = Id<"clos">
export type ProviderAbsenceId = Id<"absn">
export type BusinessHoursId = Id<"bhrs">
export type BookingEventId = Id<"evnt">
export type AuditLogId = Id<"audt">
export type IdempotencyKeyId = Id<"idem">
export type StaffId = Id<"staf">

export const parseBookingId = parseId("book")
export const parseServiceId = parseId("serv")
export const parseProviderId = parseId("prov")
export const parseResourceId = parseId("rsrc")
export const parseClosureId = parseId("clos")
export const parseProviderAbsenceId = parseId("absn")
export const parseBusinessHoursId = parseId("bhrs")
export const parseBookingEventId = parseId("evnt")
export const parseAuditLogId = parseId("audt")
export const parseIdempotencyKeyId = parseId("idem")
export const parseStaffId = parseId("staf")

export const newBookingId = newId("book")
export const newServiceId = newId("serv")
export const newProviderId = newId("prov")
export const newResourceId = newId("rsrc")
export const newClosureId = newId("clos")
export const newProviderAbsenceId = newId("absn")
export const newBusinessHoursId = newId("bhrs")
export const newBookingEventId = newId("evnt")
export const newAuditLogId = newId("audt")
export const newIdempotencyKeyId = newId("idem")
export const newStaffId = newId("staf")
