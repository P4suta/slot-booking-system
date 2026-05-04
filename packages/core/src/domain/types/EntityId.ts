import { Either } from "effect"
import { typeid } from "typeid-js"
import { type DomainError, InvalidEntityIdError } from "../errors/Errors.js"
import type { Brand } from "./Brand.js"

/**
 * TypeID-shaped entity identifiers, branded so they cannot be mistakenly
 * substituted for one another. See ADR-0003.
 *
 * Internal representation is the canonical TypeID string `<prefix>_<ULID>`.
 */
export type BookingId = Brand<string, "BookingId">
export type ServiceId = Brand<string, "ServiceId">
export type ProviderId = Brand<string, "ProviderId">
export type ResourceId = Brand<string, "ResourceId">
export type ClosureId = Brand<string, "ClosureId">
export type ProviderAbsenceId = Brand<string, "ProviderAbsenceId">
export type BusinessHoursId = Brand<string, "BusinessHoursId">
export type BookingEventId = Brand<string, "BookingEventId">
export type AuditLogId = Brand<string, "AuditLogId">
export type IdempotencyKeyId = Brand<string, "IdempotencyKeyId">

/** Stable mapping from prefix to the TypeScript brand name. */
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

const TYPEID_PATTERN = /^([a-z]{1,63})_([0-9a-z]{26})$/

const matchesPrefix = (s: string, prefix: EntityPrefix): boolean => {
  const m = TYPEID_PATTERN.exec(s)
  return m !== null && m[1] === prefix
}

const parser =
  <Id extends string>(prefix: EntityPrefix) =>
  (s: string): Either.Either<Id, DomainError> =>
    matchesPrefix(s, prefix)
      ? Either.right(s as unknown as Id)
      : Either.left(new InvalidEntityIdError({ expectedPrefix: `${prefix}_`, received: s }))

const generator =
  <Id extends string>(prefix: EntityPrefix) =>
  (): Id =>
    typeid(prefix).toString() as unknown as Id

export const parseBookingId = parser<BookingId>("book")
export const parseServiceId = parser<ServiceId>("serv")
export const parseProviderId = parser<ProviderId>("prov")
export const parseResourceId = parser<ResourceId>("rsrc")
export const parseClosureId = parser<ClosureId>("clos")
export const parseProviderAbsenceId = parser<ProviderAbsenceId>("absn")
export const parseBusinessHoursId = parser<BusinessHoursId>("bhrs")
export const parseBookingEventId = parser<BookingEventId>("evnt")
export const parseAuditLogId = parser<AuditLogId>("audt")
export const parseIdempotencyKeyId = parser<IdempotencyKeyId>("idem")

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
