import { Context, type Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import type { BookingNotFoundError } from "../../domain/errors/Errors.js"
import type { BookingId } from "../../domain/types/EntityId.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"

/**
 * Aggregate-scoped persistence for `Booking`. Production binds this to
 * a Cloudflare D1 backing store; tests use an in-memory fake.
 *
 * Lookups never expose customer PII as part of their failure tag —
 * `BookingNotFoundError` is intentionally devoid of the key it failed to
 * resolve so log payloads stay PII-clean (ADR-0009).
 */
export class BookingRepository extends Context.Tag("@booking/core/BookingRepository")<
  BookingRepository,
  {
    readonly findByCode: (code: BookingCode) => Effect.Effect<Booking, BookingNotFoundError>
    readonly findById: (id: BookingId) => Effect.Effect<Booking, BookingNotFoundError>
    readonly upsert: (booking: Booking) => Effect.Effect<void>
  }
>() {}
