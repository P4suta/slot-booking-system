import { Context, type Effect } from "effect"
import type {
  AuditLogId,
  IdempotencyKeyId,
  StaffId,
  TicketEventId,
  TicketId,
} from "../../domain/types/EntityId.js"

/**
 * Centralised id generation. Production wires {@link IdGenerator} to
 * TypeID + Crockford-Base32 (`UlidIdGeneratorLive`); tests wire a
 * seeded counter (`DeterministicIdGeneratorLive`) so property tests
 * are reproducible. The kind set covers the five identifiers the
 * queue domain mints: Ticket, TicketEvent, Staff, AuditLog,
 * IdempotencyKey.
 */
export class IdGenerator extends Context.Service<
  IdGenerator,
  {
    readonly newTicketId: Effect.Effect<TicketId>
    readonly newTicketEventId: Effect.Effect<TicketEventId>
    readonly newStaffId: Effect.Effect<StaffId>
    readonly newAuditLogId: Effect.Effect<AuditLogId>
    readonly newIdempotencyKeyId: Effect.Effect<IdempotencyKeyId>
  }
>()("@booking/core/IdGenerator") {}
