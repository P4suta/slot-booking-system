import { Schema } from "effect"
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
 * Constructor-side metadata every concrete error class must declare. The
 * pair `(code, severity)` lives on the class (not the instance), so the
 * tag → code / tag → severity mapping is co-located with the error
 * definition itself rather than in a separate lookup table. Phase 2.0
 * pulls these reads through a typed `metadataOf` accessor — no
 * `as unknown as ...` cast.
 */
export type ErrorClassMetadata = {
  readonly code: string
  readonly severity: ErrorSeverity
}

/**
 * Structural shape of `e.constructor` for every domain error class. A
 * tagged error class extends `Schema.TaggedError`'s class factory, so
 * the constructor exposes both the `Schema.fields` table (for Phase 2.0
 * field-introspection) and the {@link ErrorClassMetadata} `code` /
 * `severity` declared at the leaf class.
 */
export type ErrorClass = ErrorClassMetadata & {
  // The factory produces a `Schema.Struct.Fields` table whose `_tag`
  // entry is the literal `Schema.tag<...>` brand and the remainder are
  // ordinary `Schema.Schema.Any` codecs. The looser `unknown` value
  // type accommodates that variance — `dataOf` only walks the keys.
  readonly fields: Readonly<Record<string, unknown>>
}

/**
 * Structural narrowing of a `DomainError` instance to its class-side
 * metadata. TypeScript types `instance.constructor` as the un-narrowed
 * `Function` interface even when the instance type is a discriminated
 * union of classes that all carry the same statics — the cast bridges
 * that gap. Every member of the {@link DomainError} union is asserted
 * against {@link ErrorClass} at compile time by the
 * `errorClassRegistry` array further down this module, so the cast is
 * sound by construction (a missing `static code` / `severity` /
 * `fields` would refuse to type-check the registry entry).
 */
const metadataOf = (e: DomainError): ErrorClass => e.constructor as unknown as ErrorClass

/* -------------------------------------------------------------------------- */
/* Validation errors — boundary parsing failed.                                */
/* -------------------------------------------------------------------------- */

export class InvalidPhoneLast4Error extends Schema.TaggedError<InvalidPhoneLast4Error>()(
  "InvalidPhoneLast4",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_PHONE_LAST4"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidNameKanaError extends Schema.TaggedError<InvalidNameKanaError>()(
  "InvalidNameKana",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_NAME_KANA"
  static readonly severity: ErrorSeverity = "validation"
}

/** Why a booking code failed to parse. */
export type BookingCodeReason = "wrong-length" | "invalid-character" | "checksum-mismatch"

export const BookingCodeReasonSchema: Schema.Schema<BookingCodeReason> = Schema.Literal(
  "wrong-length",
  "invalid-character",
  "checksum-mismatch",
)

export class InvalidBookingCodeError extends Schema.TaggedError<InvalidBookingCodeError>()(
  "InvalidBookingCode",
  { reason: BookingCodeReasonSchema },
) {
  static readonly code = "E_VAL_BOOKING_CODE"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidFreeTextError extends Schema.TaggedError<InvalidFreeTextError>()(
  "InvalidFreeText",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_FREE_TEXT"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidDurationError extends Schema.TaggedError<InvalidDurationError>()(
  "InvalidDuration",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_DURATION"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidHoldingDaysError extends Schema.TaggedError<InvalidHoldingDaysError>()(
  "InvalidHoldingDays",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_HOLDING_DAYS"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidTimeSlotError extends Schema.TaggedError<InvalidTimeSlotError>()(
  "InvalidTimeSlot",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_TIME_SLOT"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidBitmapError extends Schema.TaggedError<InvalidBitmapError>()("InvalidBitmap", {
  reason: Schema.String,
}) {
  static readonly code = "E_VAL_BITMAP"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidSkillError extends Schema.TaggedError<InvalidSkillError>()("InvalidSkill", {
  reason: Schema.String,
}) {
  static readonly code = "E_VAL_SKILL"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidResourceTypeError extends Schema.TaggedError<InvalidResourceTypeError>()(
  "InvalidResourceType",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_RESOURCE_TYPE"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidWeekdayError extends Schema.TaggedError<InvalidWeekdayError>()(
  "InvalidWeekday",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_WEEKDAY"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidOpenWindowError extends Schema.TaggedError<InvalidOpenWindowError>()(
  "InvalidOpenWindow",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_OPEN_WINDOW"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidAbsenceError extends Schema.TaggedError<InvalidAbsenceError>()(
  "InvalidAbsence",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_ABSENCE"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidBusinessTimeZoneError extends Schema.TaggedError<InvalidBusinessTimeZoneError>()(
  "InvalidBusinessTimeZone",
  { value: Schema.String },
) {
  static readonly code = "E_VAL_BUSINESS_TZ"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidEntityIdError extends Schema.TaggedError<InvalidEntityIdError>()(
  "InvalidEntityId",
  {
    expectedPrefix: Schema.String,
    received: Schema.String,
  },
) {
  static readonly code = "E_VAL_ENTITY_ID"
  static readonly severity: ErrorSeverity = "validation"
}

export const CatalogEntitySchema: Schema.Schema<
  "service" | "provider" | "resource" | "businessHours" | "closure" | "providerAbsence"
> = Schema.Literal("service", "provider", "resource", "businessHours", "closure", "providerAbsence")
export type CatalogEntity = Schema.Schema.Type<typeof CatalogEntitySchema>

/**
 * Schema decoding rejected a catalog input payload (Service / Provider /
 * Resource / BusinessHours / Closure / ProviderAbsence). Distinct from
 * the per-value-object validation errors above because catalog inputs
 * arrive as a whole struct and the failure may be in any field — the
 * carrier `entity` records which entity rejected, `reason` carries the
 * Schema parse summary.
 */
export class InvalidCatalogInputError extends Schema.TaggedError<InvalidCatalogInputError>()(
  "InvalidCatalogInput",
  {
    entity: CatalogEntitySchema,
    reason: Schema.String,
  },
) {
  static readonly code = "E_VAL_CATALOG_INPUT"
  static readonly severity: ErrorSeverity = "validation"
}

export const MissingStaffCapabilityReasonSchema: Schema.Schema<
  "absent" | "malformed" | "wrong_kind"
> = Schema.Literal("absent", "malformed", "wrong_kind")
export type MissingStaffCapabilityReason = Schema.Schema.Type<
  typeof MissingStaffCapabilityReasonSchema
>

/**
 * The request did not present a valid `StaffCapability`. Covers four
 * causes the boundary cannot distinguish without leaking auth detail:
 * missing header, malformed envelope (base64 / JSON parse), invalid
 * Schema shape, and capability tag other than `StaffCapability`. Lack
 * of *scope* on an otherwise-valid `StaffCapability` is a domain rule
 * error (`InsufficientCapability`), not this one.
 */
export class MissingStaffCapabilityError extends Schema.TaggedError<MissingStaffCapabilityError>()(
  "MissingStaffCapability",
  { reason: MissingStaffCapabilityReasonSchema },
) {
  static readonly code = "E_VAL_MISSING_STAFF_CAPABILITY"
  static readonly severity: ErrorSeverity = "validation"
}

/* -------------------------------------------------------------------------- */
/* Domain errors — business rule violations.                                   */
/* -------------------------------------------------------------------------- */

export class BookingNotFoundError extends Schema.TaggedError<BookingNotFoundError>()(
  "BookingNotFound",
  {},
) {
  static readonly code = "E_DOM_BOOKING_NOT_FOUND"
  static readonly severity: ErrorSeverity = "domain"
}

export class PhoneMismatchError extends Schema.TaggedError<PhoneMismatchError>()(
  "PhoneMismatch",
  {},
) {
  static readonly code = "E_DOM_PHONE_MISMATCH"
  static readonly severity: ErrorSeverity = "domain"
}

export class AlreadyCancelledError extends Schema.TaggedError<AlreadyCancelledError>()(
  "AlreadyCancelled",
  {},
) {
  static readonly code = "E_DOM_ALREADY_CANCELLED"
  static readonly severity: ErrorSeverity = "domain"
}

export class AlreadyCompletedError extends Schema.TaggedError<AlreadyCompletedError>()(
  "AlreadyCompleted",
  {},
) {
  static readonly code = "E_DOM_ALREADY_COMPLETED"
  static readonly severity: ErrorSeverity = "domain"
}

export class AlreadyNoShowError extends Schema.TaggedError<AlreadyNoShowError>()(
  "AlreadyNoShow",
  {},
) {
  static readonly code = "E_DOM_ALREADY_NO_SHOW"
  static readonly severity: ErrorSeverity = "domain"
}

export class SlotExpiredError extends Schema.TaggedError<SlotExpiredError>()("SlotExpired", {}) {
  static readonly code = "E_DOM_SLOT_EXPIRED"
  static readonly severity: ErrorSeverity = "domain"
}

export class SlotUnavailableError extends Schema.TaggedError<SlotUnavailableError>()(
  "SlotUnavailable",
  {},
) {
  static readonly code = "E_DOM_SLOT_UNAVAILABLE"
  static readonly severity: ErrorSeverity = "domain"
}

export class OutsideBusinessHoursError extends Schema.TaggedError<OutsideBusinessHoursError>()(
  "OutsideBusinessHours",
  {},
) {
  static readonly code = "E_DOM_OUTSIDE_HOURS"
  static readonly severity: ErrorSeverity = "domain"
}

export class ServiceDisabledError extends Schema.TaggedError<ServiceDisabledError>()(
  "ServiceDisabled",
  {},
) {
  static readonly code = "E_DOM_SERVICE_DISABLED"
  static readonly severity: ErrorSeverity = "domain"
}

export class ProviderUnavailableError extends Schema.TaggedError<ProviderUnavailableError>()(
  "ProviderUnavailable",
  {},
) {
  static readonly code = "E_DOM_PROVIDER_UNAVAILABLE"
  static readonly severity: ErrorSeverity = "domain"
}

export class ResourceUnavailableError extends Schema.TaggedError<ResourceUnavailableError>()(
  "ResourceUnavailable",
  {},
) {
  static readonly code = "E_DOM_RESOURCE_UNAVAILABLE"
  static readonly severity: ErrorSeverity = "domain"
}

export class InvalidStateTransitionError extends Schema.TaggedError<InvalidStateTransitionError>()(
  "InvalidStateTransition",
  {
    from: Schema.String,
    command: Schema.String,
  },
) {
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
export class InsufficientCapabilityError extends Schema.TaggedError<InsufficientCapabilityError>()(
  "InsufficientCapability",
  {
    required: Schema.String,
    capability: Schema.String,
  },
) {
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
export class AggregateNotFoundError extends Schema.TaggedError<AggregateNotFoundError>()(
  "AggregateNotFound",
  {},
) {
  static readonly code = "E_INF_AGG_NOT_FOUND"
  static readonly severity: ErrorSeverity = "infrastructure"
}

/**
 * Optimistic-concurrency check failed at `EventSourcedRepository.save`:
 * caller's `expected` revision does not match the storage's current
 * revision (another writer slipped in). Caller should re-read via
 * `load` and retry, or surface a 409 to the user.
 */
export class ConcurrencyError extends Schema.TaggedError<ConcurrencyError>()("Concurrency", {
  expected: Schema.Number,
  actual: Schema.Number,
}) {
  static readonly code = "E_INF_CONCURRENCY"
  static readonly severity: ErrorSeverity = "infrastructure"
}

/**
 * Generic storage failure — disk I/O error, schema drift, txn aborted,
 * `D1Database` rejected the batch, etc. `reason` is an operator-facing
 * string (never PII). `cause` is a first-class field (Phase 2.0 / BI-2)
 * carrying the underlying defect or rejected error so log sinks can
 * unfold it; it is the *only* error class with a cause field, because
 * production code only ever attaches a cause at storage / RPC boundary
 * sites (`Effect.tryPromise.catch`, `Effect.catchAllDefect`).
 */
export class StorageError extends Schema.TaggedError<StorageError>()("Storage", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {
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

export const codeOf = (e: DomainError): string => metadataOf(e).code
export const severityOf = (e: DomainError): ErrorSeverity => metadataOf(e).severity

/**
 * Map an error to a structured payload safe for log sinks. The output
 * is a plain object (no `Error.prototype` fields) carrying:
 *   - `_tag`, `code`, `severity`
 *   - the error's own scalar/structured payload (the constructor args,
 *     enumerated via the Schema `fields` on the class — Phase 2.0 / BI-2)
 *   - `traceId` (passed in by the log layer from the active OTel
 *     span via `getCurrentTraceId` — domain errors no longer carry
 *     it themselves)
 *   - `cause` only when the error class has one as a payload field
 *     (currently `StorageError`); the unwrapping is delegated to
 *     {@link extractCausePreview}.
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
  readonly data: Readonly<Record<string, unknown>>
}

const extractCausePreview = (raw: unknown): LogPayload["cause"] => {
  if (raw instanceof Error) return { name: raw.name, message: raw.message }
  return undefined
}

/**
 * Enumerate the payload fields declared on the error's class, excluding
 * the discriminator (`_tag`) and any infrastructure-only carrier
 * (`cause`, surfaced separately via {@link extractCausePreview}). The
 * iteration is driven by `e.constructor.fields` — the Schema fields
 * static the `Schema.TaggedError` factory installs on the class — so
 * adding a new field to a class instantly shows up in log payloads with
 * no separate registration.
 */
const dataOf = (e: DomainError): Readonly<Record<string, unknown>> => {
  const klass = metadataOf(e)
  const out: Record<string, unknown> = {}
  const view = e as unknown as Readonly<Record<string, unknown>>
  for (const key of Object.keys(klass.fields)) {
    if (key === "_tag" || key === "cause") continue
    out[key] = view[key]
  }
  return out
}

export type ToLogPayloadOptions = {
  readonly traceId?: TraceId
}

export const toLogPayload = (e: DomainError, options: ToLogPayloadOptions = {}): LogPayload => {
  const payload: Mutable<LogPayload> = {
    _tag: e._tag,
    code: codeOf(e),
    severity: severityOf(e),
    data: dataOf(e),
  }
  if (options.traceId !== undefined) payload.traceId = options.traceId
  if (e._tag === "Storage") {
    const preview = extractCausePreview(e.cause)
    if (preview !== undefined) payload.cause = preview
  }
  return payload
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/* -------------------------------------------------------------------------- */
/* Compile-time class-side contract registry.                                  */
/* -------------------------------------------------------------------------- */

/**
 * Module-level structural assertion that every concrete error class
 * carries the {@link ErrorClass} class-side contract: `code`,
 * `severity`, and `fields` (the latter inherited from
 * `Schema.TaggedError`'s factory). Type-checking this array compiles
 * iff every leaf class declares the metadata; the cast in
 * {@link metadataOf} is sound exactly when this list type-checks.
 *
 * Adding a new error class requires appending a single entry here; the
 * compiler then refuses to build the package until the new class also
 * declares the static metadata, which is the smallest possible
 * "if-you-add-this-don't-forget-that" obligation.
 */
export const errorClassRegistry: readonly ErrorClass[] = [
  InvalidPhoneLast4Error,
  InvalidNameKanaError,
  InvalidBookingCodeError,
  InvalidFreeTextError,
  InvalidDurationError,
  InvalidHoldingDaysError,
  InvalidTimeSlotError,
  InvalidBitmapError,
  InvalidSkillError,
  InvalidResourceTypeError,
  InvalidWeekdayError,
  InvalidOpenWindowError,
  InvalidAbsenceError,
  InvalidBusinessTimeZoneError,
  InvalidEntityIdError,
  InvalidCatalogInputError,
  MissingStaffCapabilityError,
  BookingNotFoundError,
  PhoneMismatchError,
  AlreadyCancelledError,
  AlreadyCompletedError,
  AlreadyNoShowError,
  SlotExpiredError,
  SlotUnavailableError,
  OutsideBusinessHoursError,
  ServiceDisabledError,
  ProviderUnavailableError,
  ResourceUnavailableError,
  InvalidStateTransitionError,
  InsufficientCapabilityError,
  AggregateNotFoundError,
  ConcurrencyError,
  StorageError,
]
