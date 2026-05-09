import type { DomainError } from "@booking/core"
import { Match } from "effect"
import { currentTraceId } from "./traceIdHeader.js"

/**
 * Exhaustive `(DomainError | "Defect") -> {status, body}` mapping.
 * The previous router's `statusForError` walked a `tag.startsWith` /
 * `||` chain which kept growing every time a new error landed; the
 * `Match.tagged` form forces a compile error if a future
 * `DomainError` _tag is added without a status assignment, which is
 * the only way to keep the API surface honest as the domain grows.
 *
 * Status mapping by tag:
 *   - 404: TicketNotFound, AggregateNotFound, InvalidEntityId
 *   - 403: PhoneMismatch, MissingStaffCapability, InsufficientCapability
 *   - 409: QueueEmpty, AlreadyCancelled, AlreadyCompleted, AlreadyNoShow,
 *          InvalidStateTransition, Concurrency
 *   - 422: InvalidPhoneLast4, InvalidNameKana, InvalidFreeText,
 *          InvalidBusinessTimeZone (validation-shaped errors)
 *   - 500: Storage, Defect (server-side / unexpected)
 */
const status = Match.type<DomainError["_tag"]>().pipe(
  Match.when("TicketNotFound", () => 404),
  Match.when("AggregateNotFound", () => 404),
  Match.when("InvalidEntityId", () => 404),
  Match.when("PhoneMismatch", () => 403),
  Match.when("MissingStaffCapability", () => 403),
  Match.when("InsufficientCapability", () => 403),
  Match.when("QueueEmpty", () => 409),
  Match.when("AlreadyCancelled", () => 409),
  Match.when("AlreadyCompleted", () => 409),
  Match.when("AlreadyNoShow", () => 409),
  Match.when("InvalidStateTransition", () => 409),
  Match.when("Concurrency", () => 409),
  Match.when("InvalidPhoneLast4", () => 422),
  Match.when("InvalidNameKana", () => 422),
  Match.when("InvalidFreeText", () => 422),
  Match.when("InvalidBusinessTimeZone", () => 422),
  Match.when("Storage", () => 500),
  Match.exhaustive,
)

/**
 * Map a `DomainError._tag` to its HTTP status. Pure projection; the
 * caller assembles the JSON body from `_tag`, `code`, and any
 * tag-specific extras (e.g. `MissingStaffCapability.reason`).
 */
export const statusForTag = (tag: DomainError["_tag"]): number => status(tag)

/**
 * Defect (unhandled fault) gets a vanilla 500. Defects bypass the
 * tagged-union exhaustive mapping by design — they are programmer
 * errors, not domain errors, and shouldn't widen the surface.
 */
export const DEFECT_STATUS = 500

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
