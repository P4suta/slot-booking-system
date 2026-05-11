import type { DomainError } from "@booking/core"
import { currentTraceId } from "./traceIdHeader.js"

/**
 * Exhaustive `DomainError._tag -> HTTP status` mapping. Defined as
 * a `Record<Tag, number>` so the TypeScript checker rejects any
 * commit that adds a new tag to `DomainError` without registering
 * its status — the same compile-time exhaustiveness `Match.tagged`
 * gives, but without the `pipe` argument-count cap (the registry
 * grew past 20 entries with ADR-0066 / ADR-0068).
 *
 * Status mapping by tag:
 *   - 404: TicketNotFound, AggregateNotFound, InvalidEntityId
 *   - 403: PhoneMismatch, MissingStaffCapability, InsufficientCapability
 *   - 409: QueueEmpty, AlreadyCancelled, AlreadyCompleted, AlreadyNoShow,
 *          InvalidStateTransition, LaneMismatch, SlotFull,
 *          CheckInTooEarly, Concurrency
 *   - 422: InvalidPhoneLast4, InvalidNameKana, InvalidFreeText,
 *          InvalidBusinessTimeZone, SlotInPast,
 *          AppointmentRequiredForReservationLane
 *   - 500: Storage, Defect (server-side / unexpected)
 */
const STATUS_BY_TAG: Record<DomainError["_tag"], number> = {
  TicketNotFound: 404,
  AggregateNotFound: 404,
  InvalidEntityId: 404,
  PhoneMismatch: 403,
  MissingStaffCapability: 403,
  InsufficientCapability: 403,
  QueueEmpty: 409,
  AlreadyCancelled: 409,
  AlreadyCompleted: 409,
  AlreadyNoShow: 409,
  InvalidStateTransition: 409,
  LaneMismatch: 409,
  SlotFull: 409,
  CheckInTooEarly: 409,
  Concurrency: 409,
  InvalidPhoneLast4: 422,
  InvalidNameKana: 422,
  InvalidFreeText: 422,
  InvalidBusinessTimeZone: 422,
  SlotInPast: 422,
  AppointmentRequiredForReservationLane: 422,
  Storage: 500,
}

/**
 * Map a `DomainError._tag` to its HTTP status. Pure projection; the
 * caller assembles the JSON body from `_tag`, `code`, and any
 * tag-specific extras (e.g. `MissingStaffCapability.reason`).
 */
export const statusForTag = (tag: DomainError["_tag"]): number => STATUS_BY_TAG[tag]

/**
 * Defect (unhandled fault) gets a vanilla 500. Defects bypass the
 * tagged-union exhaustive mapping by design — they are programmer
 * errors, not domain errors, and shouldn't widen the surface.
 */
export const DEFECT_STATUS = 500

/**
 * Sanitised, dev-only debug context attached to an error envelope.
 *
 * Stage 21 / ADR-0089 — without this, a 401 / 422 only carries
 * `_tag` + `code`, which collapses three otherwise-distinct root
 * causes ("password value wrong", "JWT expired", "session cookie
 * HMAC mismatch") into one opaque envelope. The field is emitted
 * only when {@link isDevMode} returns true; production responses
 * remain `{ ok: false, error: { _tag, code } }` byte-for-byte.
 *
 * Every field is structurally sanitised:
 *   - `reason` is a closed discriminant (e.g. `"bearer_invalid"`),
 *     not a free-form error string from the verifier;
 *   - `*Len` are integer character counts — leak nothing beyond
 *     "the operator typed N characters";
 *   - `*Head` / `*Tail` cap at four characters so the previewer
 *     can spot "I forgot the trailing newline" / "I pasted with a
 *     leading space" without exposing the whole secret;
 *   - `field` is the boundary's `firstFailedFieldKey` output (a
 *     known field name from the Schema, not user input);
 *   - `hint` is a static, hand-curated remediation string.
 *
 * Never widen the type to carry the raw credential, the verifier's
 * exception message, or any structured-clone of the request body.
 * That widening would defeat the whole point of redaction.
 */
export type DebugEnvelope = {
  readonly reason: string
  readonly receivedLen?: number
  readonly expectedLen?: number
  readonly receivedHead?: string
  readonly receivedTail?: string
  readonly field?: string
  readonly hint?: string
}

/**
 * Maximum chars copied from a presented credential into the
 * `receivedHead` / `receivedTail` preview. Four chars is enough to
 * spot whitespace / case-folding / trailing-newline mistakes without
 * giving an attacker a useful prefix oracle.
 */
export const DEBUG_PREVIEW_CHARS = 4

/**
 * `IS_DEV === "1"` is the canonical dev-mode flag across the
 * worker (`securityHeaders.ts` / `corsAllowlist` already keys off
 * it). Centralised here so the envelope-enrichment code path uses
 * exactly the same predicate, and a future "staging" tier can be
 * added in one place.
 */
export const isDevMode = (env: { readonly IS_DEV?: string }): boolean => env.IS_DEV === "1"

/**
 * Structured-log entry emitted on every error response (status
 * ≥ 400 with a JSON `{ok: false}` envelope). The shape mirrors
 * the rest of the structured-log surface (`HttpRequest`,
 * `WorkersLoggerLive`) so the operator can filter on `_tag` /
 * `errorTag` / `traceId` without per-source regex.
 */
export type HttpEnvelopeLog = {
  readonly errorTag: string
  readonly errorCode: string
  readonly status: number
  readonly path: string
  readonly method: string
  readonly traceId: string | null
  readonly message?: string
}

/**
 * Test-only seam — integration / unit tests run inside the same
 * isolate as this module, so a module-level callback is enough
 * to capture every emitted entry without scraping stdout. The
 * callback is null in production code paths (single null check
 * per error response).
 */
let tap: ((entry: HttpEnvelopeLog) => void) | null = null
export const __setEnvelopeLogTap = (next: ((entry: HttpEnvelopeLog) => void) | null): void => {
  tap = next
}

/**
 * Emit a structured `HttpEnvelope` log line. Called by the
 * `envelopeLog` middleware on every JSON error response and by
 * `onError` on uncaught throws.
 */
export const logHttpEnvelope = (entry: Omit<HttpEnvelopeLog, "traceId">): void => {
  const traceId = currentTraceId()
  const full: HttpEnvelopeLog = { ...entry, traceId }
  // `console.warn` is in biome's noConsole allow-list (warn/error are
  // the structured-log levels we use repo-wide); the JSON-line shape
  // mirrors `WorkersLoggerLive` so the operator dashboard can filter
  // on `_tag` / `errorTag` without per-source regex.
  console.warn(
    JSON.stringify({
      _tag: "HttpEnvelope",
      code: "I_HTTP_ENVELOPE",
      severity: "infrastructure",
      ...full,
    }),
  )
  if (tap !== null) tap(full)
}
