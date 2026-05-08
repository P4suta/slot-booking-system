import { Context, type Effect } from "effect"
import type {
  AuditLogId,
  IdempotencyKeyId,
  StaffId,
  TicketEventId,
  TicketId,
} from "../../domain/types/EntityId.js"

/**
 * Centralised id generation, abstracted as an `Effect.Tag`. Production
 * wires {@link IdGenerator} to TypeID + Crockford-Base32
 * (`UlidIdGeneratorLive`); tests wire a seeded counter
 * (`DeterministicIdGeneratorLive`) so property tests are reproducible.
 *
 * The Phase 1 queue pivot narrows the kind set to the five identifiers
 * the queue domain mints (`Ticket`, `TicketEvent`, `Staff`, `AuditLog`,
 * `IdempotencyKey`); the booking-graph kinds (book / serv / prov /
 * rsrc / clos / absn / bhrs) are gone with the slot aggregate.
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
