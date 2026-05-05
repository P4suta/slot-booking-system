import { Effect, Layer, Ref } from "effect"
import { BookingCodeIndex } from "../../application/ports/BookingCodeIndex.js"
import { add, type BloomFilter, contains, empty } from "../../domain/lookup/BloomFilter.js"

/**
 * In-memory Bloom-filter-backed {@link BookingCodeIndex}. Suitable
 * for both the local DurableObject (in-memory mirror of the active
 * booking-code keyspace) and the test suites; the production D1
 * mirror will share the same `BloomFilter` primitive but persist
 * the bit-array in a single row.
 *
 * Sizing is chosen for ~50 000 active codes at 0.1 % false-positive:
 *   m / n ≈ 14.4 → m = 720 000 bits ≈ 90 KB; k = 10. Tunable per
 *   deployment via {@link makeBloomBookingCodeIndex}'s parameters.
 *
 * The mutable bit-array lives in a `Ref<BloomFilter>` so `add` is a
 * pure functional swap. There is no STM here — the BloomFilter is
 * immutable and a `Ref.update` closure runs as a single atomic step,
 * so two concurrent `add`s commute (`bf | a | b == bf | b | a`).
 */
export type BloomBookingCodeIndexConfig = {
  readonly size: number
  readonly hashCount: number
}

export const DEFAULT_BLOOM_CONFIG: BloomBookingCodeIndexConfig = {
  size: 720_000,
  hashCount: 10,
}

export const makeBloomBookingCodeIndex = (
  config: BloomBookingCodeIndexConfig = DEFAULT_BLOOM_CONFIG,
): Layer.Layer<BookingCodeIndex> =>
  Layer.effect(
    BookingCodeIndex,
    Effect.gen(function* () {
      const ref = yield* Ref.make<BloomFilter>(empty(config.size, config.hashCount))
      return BookingCodeIndex.of({
        mayContain: (code) => Effect.map(Ref.get(ref), (bf) => contains(bf, code)),
        add: (code) => Ref.update(ref, (bf) => add(bf, code)),
      })
    }),
  )

/** Convenience layer with the default sizing. */
export const BloomBookingCodeIndexLive = makeBloomBookingCodeIndex()
