import {
  AlreadyCancelledError,
  AlreadyCompletedError,
  AlreadyNoShowError,
  type AnyError,
  BookingNotFoundError,
  InvalidAbsenceError,
  InvalidBitmapError,
  InvalidBookingCodeError,
  InvalidBusinessTimeZoneError,
  InvalidDurationError,
  InvalidEntityIdError,
  InvalidFreeTextError,
  InvalidHoldingDaysError,
  InvalidNameKanaError,
  InvalidOpenWindowError,
  InvalidPhoneLast4Error,
  InvalidResourceTypeError,
  InvalidSkillError,
  InvalidStateTransitionError,
  InvalidTimeSlotError,
  InvalidWeekdayError,
  OutsideBusinessHoursError,
  PhoneMismatchError,
  ProviderUnavailableError,
  ResourceUnavailableError,
  ServiceDisabledError,
  SlotExpiredError,
  SlotUnavailableError,
} from "./Errors.js"

/**
 * Top-level alias for any error the domain emits. Every leaf type is a
 * `Data.TaggedError` class; consumers can pattern-match on `_tag` or
 * use `instanceof` for narrowing.
 *
 * See ADR-0017 for the error-handling architecture, ADR-0009 for the
 * logging discipline that consumes these.
 */
export type DomainError = AnyError

/* -------------------------------------------------------------------------- */
/* Backwards-compatible smart constructors.                                    */
/* They build the corresponding `Data.TaggedError` class instance.             */
/* -------------------------------------------------------------------------- */

export const InvalidPhoneLast4 = (reason: string): DomainError =>
  new InvalidPhoneLast4Error({ reason })

export const InvalidNameKana = (reason: string): DomainError => new InvalidNameKanaError({ reason })

export type BookingCodeReason = "wrong-length" | "invalid-character" | "checksum-mismatch"

export const InvalidBookingCode = (reason: BookingCodeReason): DomainError =>
  new InvalidBookingCodeError({ reason })

export const InvalidFreeText = (reason: string): DomainError => new InvalidFreeTextError({ reason })

export const InvalidDuration = (reason: string): DomainError => new InvalidDurationError({ reason })

export const InvalidHoldingDays = (reason: string): DomainError =>
  new InvalidHoldingDaysError({ reason })

export const InvalidTimeSlot = (reason: string): DomainError => new InvalidTimeSlotError({ reason })

export const InvalidBitmap = (reason: string): DomainError => new InvalidBitmapError({ reason })

export const InvalidSkill = (reason: string): DomainError => new InvalidSkillError({ reason })

export const InvalidResourceType = (reason: string): DomainError =>
  new InvalidResourceTypeError({ reason })

export const InvalidWeekday = (reason: string): DomainError => new InvalidWeekdayError({ reason })

export const InvalidOpenWindow = (reason: string): DomainError =>
  new InvalidOpenWindowError({ reason })

export const InvalidAbsence = (reason: string): DomainError => new InvalidAbsenceError({ reason })

export const InvalidBusinessTimeZone = (value: string): DomainError =>
  new InvalidBusinessTimeZoneError({ value })

export const InvalidEntityId = (expectedPrefix: string, received: string): DomainError =>
  new InvalidEntityIdError({ expectedPrefix, received })

export const BookingNotFound: DomainError = new BookingNotFoundError({})
export const PhoneMismatch: DomainError = new PhoneMismatchError({})
export const AlreadyCancelled: DomainError = new AlreadyCancelledError({})
export const AlreadyCompleted: DomainError = new AlreadyCompletedError({})
export const AlreadyNoShow: DomainError = new AlreadyNoShowError({})
export const SlotExpired: DomainError = new SlotExpiredError({})
export const SlotUnavailable: DomainError = new SlotUnavailableError({})
export const OutsideBusinessHours: DomainError = new OutsideBusinessHoursError({})
export const ServiceDisabled: DomainError = new ServiceDisabledError({})
export const ProviderUnavailable: DomainError = new ProviderUnavailableError({})
export const ResourceUnavailable: DomainError = new ResourceUnavailableError({})

export const InvalidStateTransition = (from: string, command: string): DomainError =>
  new InvalidStateTransitionError({ from, command })
