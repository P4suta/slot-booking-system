import { Effect, Layer } from "effect"
import { IdGenerator } from "../../application/ports/IdGenerator.js"
import {
  newAuditLogId,
  newIdempotencyKeyId,
  newStaffId,
  newTicketEventId,
  newTicketId,
} from "../../domain/types/EntityId.js"

/**
 * Production adapter for `IdGenerator`. Each method delegates to the
 * `typeid-js`-backed mint helper from `domain/types/EntityId.ts`,
 * which produces TypeID + Crockford-Base32 strings (ADR-0003).
 */
export const UlidIdGeneratorLive = Layer.succeed(IdGenerator, {
  newTicketId: Effect.sync(newTicketId),
  newTicketEventId: Effect.sync(newTicketEventId),
  newStaffId: Effect.sync(newStaffId),
  newAuditLogId: Effect.sync(newAuditLogId),
  newIdempotencyKeyId: Effect.sync(newIdempotencyKeyId),
})
