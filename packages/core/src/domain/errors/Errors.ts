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
 * definition itself rather than in a separate lookup table.
 */
export type ErrorClassMetadata = {
  readonly code: string
  readonly severity: ErrorSeverity
}

/**
 * Structural shape of `e.constructor` for every domain error class. A
 * tagged error class extends `Schema.TaggedError`'s class factory, so
 * the constructor exposes both the `Schema.fields` table and the
 * {@link ErrorClassMetadata} `code` / `severity` declared at the leaf
 * class.
 */
export type ErrorClass = ErrorClassMetadata & {
  readonly fields: Readonly<Record<string, unknown>>
}

const metadataOf = (e: DomainError): ErrorClass => e.constructor as unknown as ErrorClass

/* -------------------------------------------------------------------------- */
/* Validation errors — boundary parsing failed.                                */
/* -------------------------------------------------------------------------- */

export class InvalidPhoneLast4Error extends Schema.TaggedErrorClass<InvalidPhoneLast4Error>()(
  "InvalidPhoneLast4",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_PHONE_LAST4"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidNameKanaError extends Schema.TaggedErrorClass<InvalidNameKanaError>()(
  "InvalidNameKana",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_NAME_KANA"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidFreeTextError extends Schema.TaggedErrorClass<InvalidFreeTextError>()(
  "InvalidFreeText",
  { reason: Schema.String },
) {
  static readonly code = "E_VAL_FREE_TEXT"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidBusinessTimeZoneError extends Schema.TaggedErrorClass<InvalidBusinessTimeZoneError>()(
  "InvalidBusinessTimeZone",
  { value: Schema.String },
) {
  static readonly code = "E_VAL_BUSINESS_TZ"
  static readonly severity: ErrorSeverity = "validation"
}

export class InvalidEntityIdError extends Schema.TaggedErrorClass<InvalidEntityIdError>()(
  "InvalidEntityId",
  {
    expectedPrefix: Schema.String,
    received: Schema.String,
  },
) {
  static readonly code = "E_VAL_ENTITY_ID"
  static readonly severity: ErrorSeverity = "validation"
}

export const MissingStaffCapabilityReasonSchema = Schema.Literals([
  "absent",
  "malformed",
  "wrong_kind",
])
export type MissingStaffCapabilityReason = Schema.Schema.Type<
  typeof MissingStaffCapabilityReasonSchema
>

/**
 * The request did not present a valid `StaffCapability`. Covers the four
 * causes the boundary cannot distinguish without leaking auth detail:
 * missing header, malformed envelope (base64 / JSON parse), invalid
 * Schema shape, and capability tag other than `StaffCapability`. Lack
 * of *scope* on an otherwise-valid `StaffCapability` is a domain rule
 * error (`InsufficientCapability`), not this one.
 */
export class MissingStaffCapabilityError extends Schema.TaggedErrorClass<MissingStaffCapabilityError>()(
  "MissingStaffCapability",
  { reason: MissingStaffCapabilityReasonSchema },
) {
  static readonly code = "E_VAL_MISSING_STAFF_CAPABILITY"
  static readonly severity: ErrorSeverity = "validation"
}

/* -------------------------------------------------------------------------- */
/* Domain errors — business rule violations.                                   */
/* -------------------------------------------------------------------------- */

/**
 * The customer's handle (phoneLast4) did not match the ticket's stored
 * value. Defends against ticket-id enumeration: an attacker who guesses
 * a valid id still cannot mutate the ticket without the matching weak
 * factor.
 */
export class PhoneMismatchError extends Schema.TaggedErrorClass<PhoneMismatchError>()(
  "PhoneMismatch",
  {},
) {
  static readonly code = "E_DOM_PHONE_MISMATCH"
  static readonly severity: ErrorSeverity = "domain"
}

/**
 * Domain-level "the ticket the customer asked about does not exist".
 * Distinct from {@link AggregateNotFoundError} which is the storage
 * port's hard miss. The use case maps the latter to the former when
 * the missed lookup is part of an authenticated customer flow.
 */
export class TicketNotFoundError extends Schema.TaggedErrorClass<TicketNotFoundError>()(
  "TicketNotFound",
  {},
) {
  static readonly code = "E_DOM_TICKET_NOT_FOUND"
  static readonly severity: ErrorSeverity = "domain"
}

/**
 * The "next ticket" command was issued but no `Waiting` ticket exists
 * to call. The staff dashboard prevents this from being clickable;
 * the error covers the race window where two staff actions hit at
 * once and the projection updates between read and write.
 */
export class QueueEmptyError extends Schema.TaggedErrorClass<QueueEmptyError>()("QueueEmpty", {}) {
  static readonly code = "E_DOM_QUEUE_EMPTY"
  static readonly severity: ErrorSeverity = "domain"
}

/**
 * The ticket has already reached the `Cancelled` terminal state and
 * does not accept further commands.
 */
export class AlreadyCancelledError extends Schema.TaggedErrorClass<AlreadyCancelledError>()(
  "AlreadyCancelled",
  {},
) {
  static readonly code = "E_DOM_ALREADY_CANCELLED"
  static readonly severity: ErrorSeverity = "domain"
}

/**
 * The ticket has already reached the `Served` terminal state and does
 * not accept further commands.
 */
export class AlreadyCompletedError extends Schema.TaggedErrorClass<AlreadyCompletedError>()(
  "AlreadyCompleted",
  {},
) {
  static readonly code = "E_DOM_ALREADY_COMPLETED"
  static readonly severity: ErrorSeverity = "domain"
}

/**
 * The ticket has already reached the `NoShow` terminal state and does
 * not accept further commands.
 */
export class AlreadyNoShowError extends Schema.TaggedErrorClass<AlreadyNoShowError>()(
  "AlreadyNoShow",
  {},
) {
  static readonly code = "E_DOM_ALREADY_NO_SHOW"
  static readonly severity: ErrorSeverity = "domain"
}

/**
 * A command tried to apply a transition that the current state does not
 * accept (e.g. `MarkServed` while `Waiting`). Carries the offending
 * state and command names so log readers can read the failed edge off
 * the `(state, command) → next` lattice without reconstructing context.
 */
export class InvalidStateTransitionError extends Schema.TaggedErrorClass<InvalidStateTransitionError>()(
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
 * scope the command needs. The `_tag` enum at the schema level filters
 * out the obvious cases (a Customer cannot issue staff-only commands);
 * this error covers the residual scope-membership check inside `apply`.
 */
export class InsufficientCapabilityError extends Schema.TaggedErrorClass<InsufficientCapabilityError>()(
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
 * domain-level "the ticket the user asked about does not exist" —
 * `AggregateNotFoundError` is raised by the `EventSourcedRepository.load`
 * port when the underlying storage has no entry for the requested id
 * (e.g. invalid id, purged aggregate).
 */
export class AggregateNotFoundError extends Schema.TaggedErrorClass<AggregateNotFoundError>()(
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
export class ConcurrencyError extends Schema.TaggedErrorClass<ConcurrencyError>()("Concurrency", {
  expected: Schema.Number,
  actual: Schema.Number,
}) {
  static readonly code = "E_INF_CONCURRENCY"
  static readonly severity: ErrorSeverity = "infrastructure"
}

/**
 * Generic storage failure — disk I/O error, schema drift, txn aborted,
 * `D1Database` rejected the batch, etc. `reason` is an operator-facing
 * string (never PII). `cause` is a first-class field carrying the
 * underlying defect or rejected error so log sinks can unfold it; it
 * is the *only* error class with a cause field, because production code
 * only ever attaches a cause at storage / RPC boundary sites.
 */
export class StorageError extends Schema.TaggedErrorClass<StorageError>()("Storage", {
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
  | InvalidFreeTextError
  | InvalidBusinessTimeZoneError
  | InvalidEntityIdError
  | MissingStaffCapabilityError

export type DomainRuleError =
  | PhoneMismatchError
  | TicketNotFoundError
  | QueueEmptyError
  | AlreadyCancelledError
  | AlreadyCompletedError
  | AlreadyNoShowError
  | InvalidStateTransitionError
  | InsufficientCapabilityError

export type InfrastructureError = AggregateNotFoundError | ConcurrencyError | StorageError

/**
 * Top-level union of every tagged error the core emits across its three
 * stratifications (boundary parse, domain rule, port-side infra).
 * Consumers pattern-match on `_tag` or narrow with `instanceof`. The
 * helpers `codeOf` / `severityOf` / `toLogPayload` accept the union
 * without branching — metadata is read from the constructor.
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
 *     enumerated via the Schema `fields` on the class)
 *   - `traceId` (passed in by the log layer from the active OTel span
 *     via `getCurrentTraceId` — domain errors no longer carry it
 *     themselves)
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

const INFRASTRUCTURE_FIELDS: ReadonlySet<string> = new Set(["_tag", "cause"])

const dataOf = (e: DomainError): Readonly<Record<string, unknown>> => {
  const view = e as unknown as Readonly<Record<string, unknown>>
  return Object.fromEntries(
    Object.keys(metadataOf(e).fields)
      .filter((key) => !INFRASTRUCTURE_FIELDS.has(key))
      .map((key) => [key, view[key]]),
  )
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
 * Every concrete error class carries the {@link ErrorClass}
 * class-side contract (`code`, `severity`, `fields`) AND extends
 * `Schema.TaggedErrorClass` so the class itself is a `Schema.Top`.
 * The tuple keeps both views: the Schema.Union codec below reads
 * the structural side, `codeOf` / `severityOf` read the metadata
 * side via {@link metadataOf}.
 */
export const errorClassRegistry = [
  InvalidPhoneLast4Error,
  InvalidNameKanaError,
  InvalidFreeTextError,
  InvalidBusinessTimeZoneError,
  InvalidEntityIdError,
  MissingStaffCapabilityError,
  PhoneMismatchError,
  TicketNotFoundError,
  QueueEmptyError,
  AlreadyCancelledError,
  AlreadyCompletedError,
  AlreadyNoShowError,
  InvalidStateTransitionError,
  InsufficientCapabilityError,
  AggregateNotFoundError,
  ConcurrencyError,
  StorageError,
] as const satisfies ReadonlyArray<ErrorClass & Schema.Top>

export const DomainErrorSchema = Schema.Union(errorClassRegistry).pipe(
  Schema.toTaggedUnion("_tag"),
) as unknown as Schema.Codec<DomainError>
