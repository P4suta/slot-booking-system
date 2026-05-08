import type { DomainError } from "@booking/core"
import { Match } from "effect"

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
