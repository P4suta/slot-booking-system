import { Data } from "effect"
import type { TraceId } from "./TraceId.js"

/**
 * Severity classification surfaced alongside the stable error code.
 * `"validation"` errors stem from boundary parsing failures; `"domain"`
 * errors stem from business-rule violations.
 */
export type ErrorSeverity = "validation" | "domain"

/**
 * Optional metadata carried by every error. Filled by the use-case /
 * presentation layer at the point the error is observed.
 *
 * `cause` is the underlying error (when one exists) — preserved so the
 * full chain reaches log sinks. `traceId` is the request-scoped
 * correlation id. `context` is a structured key-value bag for
 * non-PII contextual fields (entity ids, parameters, deployment
 * metadata).
 */
export type ErrorMeta = {
  readonly traceId?: TraceId
  readonly cause?: unknown
  readonly context?: Readonly<Record<string, unknown>>
}

/* -------------------------------------------------------------------------- */
/* Validation errors — boundary parsing failed.                                */
/* -------------------------------------------------------------------------- */

export class InvalidPhoneLast4Error extends Data.TaggedError("InvalidPhoneLast4")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_PHONE_LAST4"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidNameKanaError extends Data.TaggedError("InvalidNameKana")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_NAME_KANA"
  static readonly severity: ErrorSeverity = "validation"
}

/** Why a booking code failed to parse. */
export type BookingCodeReason = "wrong-length" | "invalid-character" | "checksum-mismatch"

export class InvalidBookingCodeError extends Data.TaggedError("InvalidBookingCode")<{
  readonly reason: BookingCodeReason
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_BOOKING_CODE"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidFreeTextError extends Data.TaggedError("InvalidFreeText")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_FREE_TEXT"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidDurationError extends Data.TaggedError("InvalidDuration")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_DURATION"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidHoldingDaysError extends Data.TaggedError("InvalidHoldingDays")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_HOLDING_DAYS"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidTimeSlotError extends Data.TaggedError("InvalidTimeSlot")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_TIME_SLOT"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidBitmapError extends Data.TaggedError("InvalidBitmap")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_BITMAP"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidSkillError extends Data.TaggedError("InvalidSkill")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_SKILL"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidResourceTypeError extends Data.TaggedError("InvalidResourceType")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_RESOURCE_TYPE"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidWeekdayError extends Data.TaggedError("InvalidWeekday")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_WEEKDAY"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidOpenWindowError extends Data.TaggedError("InvalidOpenWindow")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_OPEN_WINDOW"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidAbsenceError extends Data.TaggedError("InvalidAbsence")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_ABSENCE"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidBusinessTimeZoneError extends Data.TaggedError("InvalidBusinessTimeZone")<{
  readonly value: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_BUSINESS_TZ"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidEntityIdError extends Data.TaggedError("InvalidEntityId")<{
  readonly expectedPrefix: string
  readonly received: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_ENTITY_ID"
  static readonly severity: ErrorSeverity = "validation"
}

/* -------------------------------------------------------------------------- */
/* Domain errors — business rule violations.                                   */
/* -------------------------------------------------------------------------- */

export class BookingNotFoundError extends Data.TaggedError("BookingNotFound")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_BOOKING_NOT_FOUND"
  static readonly severity: ErrorSeverity = "domain"
}

export class PhoneMismatchError extends Data.TaggedError("PhoneMismatch")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_PHONE_MISMATCH"
  static readonly severity: ErrorSeverity = "domain"
}

export class AlreadyCancelledError extends Data.TaggedError("AlreadyCancelled")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_ALREADY_CANCELLED"
  static readonly severity: ErrorSeverity = "domain"
}

export class AlreadyCompletedError extends Data.TaggedError("AlreadyCompleted")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_ALREADY_COMPLETED"
  static readonly severity: ErrorSeverity = "domain"
}

export class AlreadyNoShowError extends Data.TaggedError("AlreadyNoShow")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_ALREADY_NO_SHOW"
  static readonly severity: ErrorSeverity = "domain"
}

export class SlotExpiredError extends Data.TaggedError("SlotExpired")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_SLOT_EXPIRED"
  static readonly severity: ErrorSeverity = "domain"
}

export class SlotUnavailableError extends Data.TaggedError("SlotUnavailable")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_SLOT_UNAVAILABLE"
  static readonly severity: ErrorSeverity = "domain"
}

export class OutsideBusinessHoursError extends Data.TaggedError("OutsideBusinessHours")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_OUTSIDE_HOURS"
  static readonly severity: ErrorSeverity = "domain"
}

export class ServiceDisabledError extends Data.TaggedError("ServiceDisabled")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_SERVICE_DISABLED"
  static readonly severity: ErrorSeverity = "domain"
}

export class ProviderUnavailableError extends Data.TaggedError("ProviderUnavailable")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_PROVIDER_UNAVAILABLE"
  static readonly severity: ErrorSeverity = "domain"
}

export class ResourceUnavailableError extends Data.TaggedError("ResourceUnavailable")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_RESOURCE_UNAVAILABLE"
  static readonly severity: ErrorSeverity = "domain"
}

export class InvalidStateTransitionError extends Data.TaggedError("InvalidStateTransition")<{
  readonly from: string
  readonly command: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_INVALID_TRANSITION"
  static readonly severity: ErrorSeverity = "domain"
}

/* -------------------------------------------------------------------------- */
/* Aggregate union types.                                                      */
/* -------------------------------------------------------------------------- */

export type ValidationError =
  | InvalidPhoneLast4Error
  | InvalidNameKanaError
  | InvalidBookingCodeError
  | InvalidFreeTextError
  | InvalidDurationError
  | InvalidHoldingDaysError
  | InvalidTimeSlotError
  | InvalidBitmapError
  | InvalidSkillError
  | InvalidResourceTypeError
  | InvalidWeekdayError
  | InvalidOpenWindowError
  | InvalidAbsenceError
  | InvalidBusinessTimeZoneError
  | InvalidEntityIdError

export type DomainRuleError =
  | BookingNotFoundError
  | PhoneMismatchError
  | AlreadyCancelledError
  | AlreadyCompletedError
  | AlreadyNoShowError
  | SlotExpiredError
  | SlotUnavailableError
  | OutsideBusinessHoursError
  | ServiceDisabledError
  | ProviderUnavailableError
  | ResourceUnavailableError
  | InvalidStateTransitionError

/**
 * Top-level union of every error the domain emits. Consumers can
 * pattern-match on `_tag` or use `instanceof` for narrowing.
 */
export type DomainError = ValidationError | DomainRuleError

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Constructor-side shape of a domain error class: every concrete error
 * class declared above carries `static readonly code` and
 * `static readonly severity` fields. Reading through the constructor
 * keeps the tag → code mapping co-located with the error definition
 * itself (no separate lookup table).
 */
type ErrorClassMetadata = {
  readonly code: string
  readonly severity: ErrorSeverity
}

const metadataOf = (e: DomainError): ErrorClassMetadata =>
  e.constructor as unknown as ErrorClassMetadata

export const codeOf = (e: DomainError): string => metadataOf(e).code
export const severityOf = (e: DomainError): ErrorSeverity => metadataOf(e).severity

/** Attach metadata to an error without mutating the original. */
export const withMeta = <E extends DomainError>(e: E, meta: ErrorMeta): E => {
  const proto = Object.getPrototypeOf(e) as object | null
  const next = Object.create(proto) as E
  Object.assign(next, e, { meta: { ...e.meta, ...meta } })
  return next
}

/**
 * Map an error to a structured payload safe for log sinks. The output
 * is a plain object (no `Error.prototype` fields) carrying only:
 *   - `_tag`, `code`, `severity`
 *   - the error's own scalar/structured payload (the constructor args)
 *   - `traceId` (when present)
 *   - cause as `{ message, name }` — the underlying object's stack
 *     trace is never serialised
 *
 * Customer PII (`nameKana`, `phoneLast4`, `freeText`) is forbidden in
 * any error's payload by construction (errors only carry IDs, codes,
 * and operator-facing reason strings) and the `pii-guard` CI step
 * rejects the patterns at source level. See ADR-0009.
 */
export type LogPayload = {
  readonly _tag: string
  readonly code: string
  readonly severity: ErrorSeverity
  readonly traceId?: TraceId
  readonly cause?: { readonly name: string; readonly message: string }
  readonly context?: Readonly<Record<string, unknown>>
  readonly data: Readonly<Record<string, unknown>>
}

const causeOf = (raw: unknown): LogPayload["cause"] => {
  if (raw instanceof Error) return { name: raw.name, message: raw.message }
  return undefined
}

const isStructuredErrorMeta = (raw: unknown): raw is ErrorMeta =>
  typeof raw === "object" && raw !== null

const dataOf = (e: DomainError): Readonly<Record<string, unknown>> => {
  // `_tag`, `meta` are handled separately. Everything else is the error's
  // domain payload — the constructor args.
  const out: Record<string, unknown> = {}
  const record = e as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (key === "_tag" || key === "meta") continue
    out[key] = value
  }
  return out
}

export const toLogPayload = (e: DomainError): LogPayload => {
  const meta = isStructuredErrorMeta(e.meta) ? e.meta : undefined
  const payload: Mutable<LogPayload> = {
    _tag: e._tag,
    code: codeOf(e),
    severity: severityOf(e),
    data: dataOf(e),
  }
  if (meta?.traceId !== undefined) payload.traceId = meta.traceId
  const cause = causeOf(meta?.cause)
  if (cause !== undefined) payload.cause = cause
  if (meta?.context !== undefined) payload.context = meta.context
  return payload
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
