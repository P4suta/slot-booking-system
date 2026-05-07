import { Context, type Effect } from "effect"
import type {
  AuditLogId,
  BookingEventId,
  BookingId,
  BusinessHoursId,
  ClosureId,
  IdempotencyKeyId,
  ProviderAbsenceId,
  ProviderId,
  ResourceId,
  ServiceId,
} from "../../domain/types/EntityId.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"

/**
 * Centralised id generation, abstracted as an `Effect.Tag`. Production
 * wires {@link IdGenerator} to a TypeID + Crockford-Base32 implementation
 * (`UlidIdGeneratorLive`); tests wire a seeded counter
 * (`DeterministicIdGeneratorLive`) so property tests are reproducible.
 *
 * All methods are `Effect`s so the layer can return failure (e.g. when a
 * deterministic generator exhausts its keyspace) without callers crafting
 * try / catch.
 */
export class IdGenerator extends Context.Service<
  IdGenerator,
  {
    readonly newBookingId: Effect.Effect<BookingId>
    readonly newServiceId: Effect.Effect<ServiceId>
    readonly newProviderId: Effect.Effect<ProviderId>
    readonly newResourceId: Effect.Effect<ResourceId>
    readonly newClosureId: Effect.Effect<ClosureId>
    readonly newProviderAbsenceId: Effect.Effect<ProviderAbsenceId>
    readonly newBusinessHoursId: Effect.Effect<BusinessHoursId>
    readonly newBookingEventId: Effect.Effect<BookingEventId>
    readonly newAuditLogId: Effect.Effect<AuditLogId>
    readonly newIdempotencyKeyId: Effect.Effect<IdempotencyKeyId>
    readonly newBookingCode: Effect.Effect<BookingCode>
  }
>()("@booking/core/IdGenerator") {}
