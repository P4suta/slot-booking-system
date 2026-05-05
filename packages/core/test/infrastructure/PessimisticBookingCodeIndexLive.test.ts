import { Effect, Either } from "effect"
import { describe, expect, it } from "vitest"
import { BookingCodeIndex } from "../../src/application/ports/BookingCodeIndex.js"
import { encodeBookingCode } from "../../src/domain/value-objects/BookingCode.js"
import { PessimisticBookingCodeIndexLive } from "../../src/infrastructure/bloom/PessimisticBookingCodeIndexLive.js"

const code = (v: bigint) => {
  const r = encodeBookingCode(v)
  if (Either.isLeft(r)) throw new Error("fixture")
  return r.right
}

describe("PessimisticBookingCodeIndexLive", () => {
  it("mayContain answers true for any code (no false negatives by construction)", async () => {
    const program = Effect.gen(function* () {
      const idx = yield* BookingCodeIndex
      return {
        zero: yield* idx.mayContain(code(0n)),
        big: yield* idx.mayContain(code(123_456n)),
      }
    })
    const out = await Effect.runPromise(
      program.pipe(Effect.provide(PessimisticBookingCodeIndexLive)),
    )
    expect(out.zero).toBe(true)
    expect(out.big).toBe(true)
  })

  it("add is a no-op (cannot fail, returns void)", async () => {
    const program = Effect.gen(function* () {
      const idx = yield* BookingCodeIndex
      yield* idx.add(code(42n))
      return yield* idx.mayContain(code(42n))
    })
    const out = await Effect.runPromise(
      program.pipe(Effect.provide(PessimisticBookingCodeIndexLive)),
    )
    expect(out).toBe(true)
  })
})
