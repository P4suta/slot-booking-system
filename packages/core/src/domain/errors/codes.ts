/**
 * Stable error codes for every domain error tag. The wire-format
 * identifier surfaced to API consumers, log payloads, and the
 * deployment-side i18n message catalogue.
 *
 * Format: `E_<SEVERITY>_<TAG>`. `SEVERITY` is one of `VAL` (validation),
 * `DOM` (domain rule), `INFRA` (infrastructure — added in Phase 1).
 *
 * The mapping is intentionally a closed enum on the TypeScript type
 * level: adding a new error tag forces a new code here, otherwise
 * `errorCode` returns `never` for the missing tag and the build fails.
 */
export type ErrorTag =
  | "InvalidPhoneLast4"
  | "InvalidNameKana"
  | "InvalidBookingCode"
  | "InvalidFreeText"
  | "InvalidDuration"
  | "InvalidHoldingDays"
  | "InvalidTimeSlot"
  | "InvalidBitmap"
  | "InvalidSkill"
  | "InvalidResourceType"
  | "InvalidWeekday"
  | "InvalidOpenWindow"
  | "InvalidAbsence"
  | "InvalidBusinessTimeZone"
  | "InvalidEntityId"
  | "BookingNotFound"
  | "PhoneMismatch"
  | "AlreadyCancelled"
  | "AlreadyCompleted"
  | "AlreadyNoShow"
  | "SlotExpired"
  | "SlotUnavailable"
  | "OutsideBusinessHours"
  | "ServiceDisabled"
  | "ProviderUnavailable"
  | "ResourceUnavailable"
  | "InvalidStateTransition"

export type ErrorSeverity = "validation" | "domain"

const TABLE: Readonly<
  Record<ErrorTag, { readonly code: string; readonly severity: ErrorSeverity }>
> = {
  InvalidPhoneLast4: { code: "E_VAL_PHONE_LAST4", severity: "validation" },
  InvalidNameKana: { code: "E_VAL_NAME_KANA", severity: "validation" },
  InvalidBookingCode: { code: "E_VAL_BOOKING_CODE", severity: "validation" },
  InvalidFreeText: { code: "E_VAL_FREE_TEXT", severity: "validation" },
  InvalidDuration: { code: "E_VAL_DURATION", severity: "validation" },
  InvalidHoldingDays: { code: "E_VAL_HOLDING_DAYS", severity: "validation" },
  InvalidTimeSlot: { code: "E_VAL_TIME_SLOT", severity: "validation" },
  InvalidBitmap: { code: "E_VAL_BITMAP", severity: "validation" },
  InvalidSkill: { code: "E_VAL_SKILL", severity: "validation" },
  InvalidResourceType: { code: "E_VAL_RESOURCE_TYPE", severity: "validation" },
  InvalidWeekday: { code: "E_VAL_WEEKDAY", severity: "validation" },
  InvalidOpenWindow: { code: "E_VAL_OPEN_WINDOW", severity: "validation" },
  InvalidAbsence: { code: "E_VAL_ABSENCE", severity: "validation" },
  InvalidBusinessTimeZone: { code: "E_VAL_BUSINESS_TZ", severity: "validation" },
  InvalidEntityId: { code: "E_VAL_ENTITY_ID", severity: "validation" },
  BookingNotFound: { code: "E_DOM_BOOKING_NOT_FOUND", severity: "domain" },
  PhoneMismatch: { code: "E_DOM_PHONE_MISMATCH", severity: "domain" },
  AlreadyCancelled: { code: "E_DOM_ALREADY_CANCELLED", severity: "domain" },
  AlreadyCompleted: { code: "E_DOM_ALREADY_COMPLETED", severity: "domain" },
  AlreadyNoShow: { code: "E_DOM_ALREADY_NO_SHOW", severity: "domain" },
  SlotExpired: { code: "E_DOM_SLOT_EXPIRED", severity: "domain" },
  SlotUnavailable: { code: "E_DOM_SLOT_UNAVAILABLE", severity: "domain" },
  OutsideBusinessHours: { code: "E_DOM_OUTSIDE_HOURS", severity: "domain" },
  ServiceDisabled: { code: "E_DOM_SERVICE_DISABLED", severity: "domain" },
  ProviderUnavailable: { code: "E_DOM_PROVIDER_UNAVAILABLE", severity: "domain" },
  ResourceUnavailable: { code: "E_DOM_RESOURCE_UNAVAILABLE", severity: "domain" },
  InvalidStateTransition: { code: "E_DOM_INVALID_TRANSITION", severity: "domain" },
}

export const errorCode = (tag: ErrorTag): string => TABLE[tag].code

export const errorSeverity = (tag: ErrorTag): ErrorSeverity => TABLE[tag].severity
