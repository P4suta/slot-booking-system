import { Either, Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { BookingSchema } from "../../src/domain/booking/Booking.js"
import { CommandSchema } from "../../src/domain/booking/Command.js"
import { BookingEventSchema } from "../../src/domain/events/BookingEvent.js"
import { computeAvailableSlots } from "../../src/domain/slot/computeAvailableSlots.js"
import { baseEnv, baseQuery } from "../_fixtures/index.js"

/**
 * Phase 2.5 / BI-6 — coverage-guided fuzz over the domain core.
 *
 * jazzer.js (libFuzzer-style) requires a Cloudflare-compatible Docker
 * setup that does not yet exist in this repo's `dev` image. The
 * pragmatic substitute that exercises the same *invariants* without
 * the new tooling is fast-check property tests against bounded but
 * adversarial inputs. The targets below each pin a structural
 * domain contract that a future jazzer.js sweep (carry-over) would
 * exercise — keeping the contracts on the existing runner means
 * nightly CI catches regressions today, and the eventual jazzer.js
 * port is a transport change rather than a new test specification.
 *
 * Invariants pinned by this suite:
 *
 *   1. **`Schema.decodeUnknown` is total** — never throws,
 *      never enters an infinite loop, returns an Either on every
 *      possible JSON-shaped input. (`BookingSchema`, `CommandSchema`,
 *      `BookingEventSchema`.) `fc.jsonValue()` is the input bound:
 *      it covers null, boolean, number, string, array, and object
 *      shapes with depth ≤ default — wide enough to exercise the
 *      Union arms' rejection paths without falling into the
 *      recursive-descent blow-up `fc.anything()` triggers when
 *      crossed with the Effect Schema parser's per-arm walk
 *      (Phase 2.5 measurement: 5+ minutes per 200 runs of
 *      `BookingSchema` × `fc.anything()`).
 *   2. **`computeAvailableSlots(env, query)` is total and structurally
 *      sound** — never throws, every emitted slot has positive
 *      duration, every emitted slot list is monotonically ordered by
 *      start time. The slot brand carries the world-consistency
 *      proof, so the structural assertions also act as a brand
 *      sanity check.
 *
 * The `apply` and `applyEvent` totality contracts that BI-6 also
 * names are exercised by the schema-arbitrary stateful test suites
 * (`bookingStateful.test.ts` / `concurrencyApply.test.ts` /
 * `projectionLattice.test.ts`); fuzzing them here with
 * `Arbitrary.make(BookingSchema)` × `Arbitrary.make(CommandSchema)`
 * proved unrealistic in this session — `Arbitrary.make` over a 5-arm
 * Union with branded refinement chains generates a heavy shrinker
 * tree per case, and 100 runs alone exceed the session-wide
 * test-budget envelope. The carry-over note in
 * `docs/migration/effect-4.md` records the followup.
 */

const decodeBookingUnknown = Schema.decodeUnknownEither(BookingSchema)
const decodeCommandUnknown = Schema.decodeUnknownEither(CommandSchema)
const decodeEventUnknown = Schema.decodeUnknownEither(BookingEventSchema)

/* -------------------------------------------------------------------------- */
/* Target 1 — Schema.decodeUnknown totality                                    */
/* -------------------------------------------------------------------------- */

describe("BI-6 fuzz: Schema.decodeUnknown is total on JSON-shaped inputs", () => {
  it("BookingSchema.decodeUnknown never throws on a random json value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const r = decodeBookingUnknown(raw)
        expect(Either.isLeft(r) || Either.isRight(r)).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it("CommandSchema.decodeUnknown never throws on a random json value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const r = decodeCommandUnknown(raw)
        expect(Either.isLeft(r) || Either.isRight(r)).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it("BookingEventSchema.decodeUnknown never throws on a random json value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const r = decodeEventUnknown(raw)
        expect(Either.isLeft(r) || Either.isRight(r)).toBe(true)
      }),
      { numRuns: 100 },
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Target 2 — computeAvailableSlots structural invariants                     */
/* -------------------------------------------------------------------------- */

describe("BI-6 fuzz: computeAvailableSlots is total and emits structurally-sound slots", () => {
  it("never throws and every slot has a positive, monotonically-ordered start", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 120 }), (granularity) => {
        let slots: ReturnType<typeof computeAvailableSlots>
        try {
          slots = computeAvailableSlots(
            baseEnv({ slotGranularityMinutes: granularity }),
            baseQuery(),
          )
        } catch (e) {
          throw new Error(
            `computeAvailableSlots threw: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
        for (const slot of slots) {
          const startMs = slot.start.toInstant().epochMilliseconds
          const endMs = slot.end.toInstant().epochMilliseconds
          expect(endMs).toBeGreaterThan(startMs)
        }
        for (let i = 1; i < slots.length; i++) {
          const prev = slots[i - 1]
          const cur = slots[i]
          if (prev !== undefined && cur !== undefined) {
            const prevStart = prev.start.toInstant().epochMilliseconds
            const curStart = cur.start.toInstant().epochMilliseconds
            expect(curStart).toBeGreaterThanOrEqual(prevStart)
          }
        }
      }),
      { numRuns: 50 },
    )
  })

  it("returns the empty list for a non-positive granularity (totality on edge)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 0 }), (granularity) => {
        const slots = computeAvailableSlots(
          baseEnv({ slotGranularityMinutes: granularity }),
          baseQuery(),
        )
        expect(slots).toEqual([])
      }),
      { numRuns: 30 },
    )
  })
})
