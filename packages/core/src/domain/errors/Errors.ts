import { Data } from "effect"
import type { TraceId } from "./TraceId.js"

/**
 * Severity classification surfaced alongside the stable error code.
 *   - `"validation"`: boundary parsing failure (input shape rejected)
 *   - `"domain"`: business-rule violation (transition disallowed, lookup miss)
 *   - `"infrastructure"`: storage / concurrency failure (race detected, txn aborted)
 *
 * The classification feeds HTTP status mapping and log routing (operator
 * dashboards split on severity).
 */
export type ErrorSeverity = "validation" | "domain" | "infrastructure"

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

/**
 * Schema decoding rejected a catalog input payload (Service / Provider /
 * Resource / BusinessHours / Closure / ProviderAbsence). Distinct from
 * the per-value-object validation errors above because catalog inputs
 * arrive as a whole struct and the failure may be in any field — the
 * carrier `entity` records which entity rejected, `reason` carries the
 * Schema parse summary.
 */
export class InvalidCatalogInputError extends Data.TaggedError("InvalidCatalogInput")<{
  readonly entity:
    | "service"
    | "provider"
    | "resource"
    | "businessHours"
    | "closure"
    | "providerAbsence"
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_CATALOG_INPUT"
  static readonly severity: ErrorSeverity = "validation"
}

/**
 * The request did not present a valid `StaffCapability`. Covers four
 * causes the boundary cannot distinguish without leaking auth detail:
 * missing header, malformed envelope (base64 / JSON parse), invalid
 * Schema shape, and capability tag other than `StaffCapability`. Lack
 * of *scope* on an otherwise-valid `StaffCapability` is a domain rule
 * error (`InsufficientCapability`), not this one.
 */
export class MissingStaffCapabilityError extends Data.TaggedError("MissingStaffCapability")<{
  readonly reason: "absent" | "malformed" | "wrong_kind"
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_VAL_MISSING_STAFF_CAPABILITY"
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

/**
 * The bearer's capability does not satisfy the command's requirements
 * — typically a `StaffCapability` whose `scopes` do not include the
 * scope the command needs (e.g. issuing `Complete` without the
 * `"complete"` scope). The `_tag` enum at the schema level filters out
 * the obvious cases (a Customer cannot issue `Complete`); this error
 * covers the residual scope-membership check inside `apply`.
 */
export class InsufficientCapabilityError extends Data.TaggedError("InsufficientCapability")<{
  readonly required: string
  readonly capability: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_DOM_INSUFFICIENT_CAPABILITY"
  static readonly severity: ErrorSeverity = "domain"
}

/* -------------------------------------------------------------------------- */
/* Infrastructure errors — storage / concurrency failures surfaced by ports.   */
/* -------------------------------------------------------------------------- */

/**
 * An aggregate id has no recorded events and no snapshot. Distinct from
 * `BookingNotFoundError` which is a domain-level "the booking the user
 * asked about does not exist". `AggregateNotFoundError` is raised by the
 * `EventSourcedRepository.load` port when the underlying storage has no
 * entry for the requested id (e.g. invalid id, purged aggregate).
 */
export class AggregateNotFoundError extends Data.TaggedError("AggregateNotFound")<{
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_INF_AGG_NOT_FOUND"
  static readonly severity: ErrorSeverity = "infrastructure"
}

/**
 * Optimistic-concurrency check failed at `EventSourcedRepository.save`:
 * caller's `expected` revision does not match the storage's current
 * revision (another writer slipped in). Caller should re-read via
 * `load` and retry, or surface a 409 to the user.
 */
export class ConcurrencyError extends Data.TaggedError("Concurrency")<{
  readonly expected: number
  readonly actual: number
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_INF_CONCURRENCY"
  static readonly severity: ErrorSeverity = "infrastructure"
}

/**
 * Generic storage failure — disk I/O error, schema drift, txn aborted,
 * `D1Database` rejected the batch, etc. Carries `reason` (operator-facing
 * string, never PII) and optional `cause` via `meta`.
 */
export class StorageError extends Data.TaggedError("Storage")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {
  static readonly code = "E_INF_STORAGE"
  static readonly severity: ErrorSeverity = "infrastructure"
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
  | InvalidCatalogInputError
  | MissingStaffCapabilityError

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
  | InsufficientCapabilityError

export type InfrastructureError = AggregateNotFoundError | ConcurrencyError | StorageError

/**
 * Top-level union of every tagged error the core emits across its three
 * stratifications (boundary parse, domain rule, port-side infra). Consumers
 * pattern-match on `_tag` or narrow with `instanceof`. The helpers
 * `codeOf` / `severityOf` / `toLogPayload` accept the union without
 * branching — metadata is read from the constructor.
 */
export type DomainError = ValidationError | DomainRuleError | InfrastructureError

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
