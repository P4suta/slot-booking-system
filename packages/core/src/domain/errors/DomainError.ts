/**
 * Tagged ADT of every domain-level error. Use the constructors below
 * rather than building objects literally so the call site is searchable
 * and the field names cannot drift.
 *
 * The error channel is the **only** way domain code signals failure.
 * `throw` is forbidden inside `domain/` and `application/` (ADR-0010).
 */
export type DomainError =
  | { readonly _tag: "InvalidPhoneLast4"; readonly reason: string }
  | { readonly _tag: "InvalidNameKana"; readonly reason: string }
  | { readonly _tag: "InvalidBookingCode"; readonly reason: BookingCodeReason }
  | { readonly _tag: "InvalidFreeText"; readonly reason: string }
  | { readonly _tag: "InvalidDuration"; readonly reason: string }
  | { readonly _tag: "InvalidHoldingDays"; readonly reason: string }
  | { readonly _tag: "InvalidTimeSlot"; readonly reason: string }
  | { readonly _tag: "InvalidBitmap"; readonly reason: string }
  | { readonly _tag: "BookingNotFound" }
  | { readonly _tag: "PhoneMismatch" }
  | { readonly _tag: "AlreadyCancelled" }
  | { readonly _tag: "AlreadyCompleted" }
  | { readonly _tag: "AlreadyNoShow" }
  | { readonly _tag: "SlotExpired" }
  | { readonly _tag: "SlotUnavailable" }
  | { readonly _tag: "OutsideBusinessHours" }
  | { readonly _tag: "ServiceDisabled" }
  | { readonly _tag: "ProviderUnavailable" }
  | { readonly _tag: "ResourceUnavailable" }
  | { readonly _tag: "InvalidStateTransition"; readonly from: string; readonly command: string }

export type BookingCodeReason = "wrong-length" | "invalid-character" | "checksum-mismatch"

export const InvalidPhoneLast4 = (reason: string): DomainError => ({
  _tag: "InvalidPhoneLast4",
  reason,
})

export const InvalidNameKana = (reason: string): DomainError => ({
  _tag: "InvalidNameKana",
  reason,
})

export const InvalidBookingCode = (reason: BookingCodeReason): DomainError => ({
  _tag: "InvalidBookingCode",
  reason,
})

export const InvalidFreeText = (reason: string): DomainError => ({
  _tag: "InvalidFreeText",
  reason,
})

export const InvalidDuration = (reason: string): DomainError => ({
  _tag: "InvalidDuration",
  reason,
})

export const InvalidHoldingDays = (reason: string): DomainError => ({
  _tag: "InvalidHoldingDays",
  reason,
})

export const InvalidTimeSlot = (reason: string): DomainError => ({
  _tag: "InvalidTimeSlot",
  reason,
})

export const InvalidBitmap = (reason: string): DomainError => ({
  _tag: "InvalidBitmap",
  reason,
})

export const BookingNotFound: DomainError = { _tag: "BookingNotFound" }
export const PhoneMismatch: DomainError = { _tag: "PhoneMismatch" }
export const AlreadyCancelled: DomainError = { _tag: "AlreadyCancelled" }
export const AlreadyCompleted: DomainError = { _tag: "AlreadyCompleted" }
export const AlreadyNoShow: DomainError = { _tag: "AlreadyNoShow" }
export const SlotExpired: DomainError = { _tag: "SlotExpired" }
export const SlotUnavailable: DomainError = { _tag: "SlotUnavailable" }
export const OutsideBusinessHours: DomainError = { _tag: "OutsideBusinessHours" }
export const ServiceDisabled: DomainError = { _tag: "ServiceDisabled" }
export const ProviderUnavailable: DomainError = { _tag: "ProviderUnavailable" }
export const ResourceUnavailable: DomainError = { _tag: "ResourceUnavailable" }

export const InvalidStateTransition = (from: string, command: string): DomainError => ({
  _tag: "InvalidStateTransition",
  from,
  command,
})
