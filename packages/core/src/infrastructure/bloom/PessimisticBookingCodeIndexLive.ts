import { Effect, Layer } from "effect"
import { BookingCodeIndex } from "../../application/ports/BookingCodeIndex.js"

/**
 * Phase 0 stub: every `mayContain` answers `true`. Adopters fall through
 * to the real {@link BookingRepository} lookup, paying the cost they
 * would have paid without the index. Phase 1 will swap this for
 * {@link BloomFilterBookingCodeIndexLive} (forthcoming) which keeps a
 * Bloom filter mirror of the booking-code keyspace and rejects ~99 %
 * of typos before the database round-trip.
 */
export const PessimisticBookingCodeIndexLive = Layer.succeed(
  BookingCodeIndex,
  BookingCodeIndex.of({
    mayContain: () => Effect.succeed(true),
    add: () => Effect.void,
  }),
)
