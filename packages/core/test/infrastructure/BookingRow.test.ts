import { Effect, Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { apply } from "../../src/domain/booking/transitions.js"
import { newBookingEventId } from "../../src/domain/types/EntityId.js"
import { BookingFromRow } from "../../src/infrastructure/schema/BookingRow.js"
import { baseHeld } from "../_fixtures/bookings.js"
import { customerCap, staffCap } from "../_fixtures/capabilities.js"
import { at } from "../_fixtures/instants.js"

const decode = Schema.decodeUnknownEither(BookingFromRow)
const encode = Schema.encodeSync(BookingFromRow)

/**
 * `BookingFromRow` is the schema-driven (DU ↔ flat row) codec
 * (ADR-0032). The five per-variant arms must round-trip identity:
 *
 *   booking → encode → row → decode → booking
 *
 * for every `Booking` variant. The test layer walks each variant
 * through `apply` to construct realistic instances and asserts the
 * round-trip preserves every field.
 */

describe("BookingFromRow", () => {
  it("round-trips a Held booking", () => {
    const held = baseHeld()
    const row = encode(held)
    const back = decode(row)
    expect(Either.isRight(back)).toBe(true)
    if (Either.isRight(back)) {
      expect(back.right).toEqual(held)
    }
  })

  it("round-trips a Confirmed booking", () => {
    const confirmedR = Either.getOrThrow(
      apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, newBookingEventId()),
    )
    const confirmed = confirmedR.booking
    const row = encode(confirmed)
    const back = decode(row)
    expect(Either.isRight(back)).toBe(true)
    if (Either.isRight(back)) {
      expect(back.right).toEqual(confirmed)
    }
  })

  it("round-trips a Cancelled booking", () => {
    const r = Either.getOrThrow(
      apply(
        baseHeld(),
        {
          kind: "Cancel",
          at: at("2026-05-09T13:00:00Z"),
          reason: "test",
          capability: customerCap(),
        },
        newBookingEventId(),
      ),
    )
    const cancelled = r.booking
    const row = encode(cancelled)
    const back = decode(row)
    expect(Either.isRight(back)).toBe(true)
    if (Either.isRight(back)) {
      expect(back.right).toEqual(cancelled)
    }
  })

  it("round-trips a Completed booking", () => {
    const confirmedR = Either.getOrThrow(
      apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, newBookingEventId()),
    )
    const completedR = Either.getOrThrow(
      apply(
        confirmedR.booking,
        { kind: "Complete", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
        newBookingEventId(),
      ),
    )
    const completed = completedR.booking
    const row = encode(completed)
    const back = decode(row)
    expect(Either.isRight(back)).toBe(true)
    if (Either.isRight(back)) {
      expect(back.right).toEqual(completed)
    }
  })

  it("round-trips a NoShow booking", () => {
    const confirmedR = Either.getOrThrow(
      apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, newBookingEventId()),
    )
    const noShowR = Either.getOrThrow(
      apply(
        confirmedR.booking,
        { kind: "MarkNoShow", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
        newBookingEventId(),
      ),
    )
    const noShow = noShowR.booking
    const row = encode(noShow)
    const back = decode(row)
    expect(Either.isRight(back)).toBe(true)
    if (Either.isRight(back)) {
      expect(back.right).toEqual(noShow)
    }
  })

  it("rejects a malformed row missing the discriminator", () => {
    const r = decode({ id: "book_x", code: "ABC-123" })
    expect(Either.isLeft(r)).toBe(true)
  })

  it("type witness: encode emits a row with state + slotStart/slotEnd, no slot object", () => {
    const held = baseHeld()
    const row = encode(held) as Record<string, unknown>
    expect(row.state).toBe("Held")
    expect(typeof row.slotStart).toBe("object") // Temporal.Instant
    expect(typeof row.slotEnd).toBe("object")
    expect(row.slot).toBeUndefined()
  })

  it("smoke: encode + decode is referentially transparent under Effect", async () => {
    // Run the codec inside an Effect to assert no hidden context-tag deps
    // leaked into the schema (the encoded codec must be R = never).
    const held = baseHeld()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const row = yield* Effect.sync(() => encode(held))
        const back = decode(row)
        return back
      }),
    )
    expect(Either.isRight(result)).toBe(true)
  })
})
