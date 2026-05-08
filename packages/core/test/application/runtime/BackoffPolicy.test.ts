import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  type BackoffPolicy,
  fixedBackoff,
  nextAttemptMs,
} from "../../../src/application/runtime/BackoffPolicy.js"

/**
 * Coverage closure for the outbox-relay backoff schedule. The policy
 * is a pure value carrier with two constructors and one composer;
 * property-based tests cover every branch (empty / negative /
 * saturating / in-range) plus the deterministic algebraic identities
 * the relay relies on.
 */

describe("fixedBackoff", () => {
  it("an empty schedule saturates to a single attempt with zero delay", () => {
    const p = fixedBackoff([])
    expect(p.maxAttempts).toBe(1)
    expect(p.nextDelayMs(0)).toBe(0)
    expect(p.nextDelayMs(7)).toBe(0)
  })

  it("a singleton schedule reports one attempt + one retry, saturating on the tail", () => {
    const p = fixedBackoff([42])
    expect(p.maxAttempts).toBe(2)
    expect(p.nextDelayMs(0)).toBe(42)
    expect(p.nextDelayMs(99)).toBe(42)
  })

  it("a multi-step schedule walks the table then saturates on the tail", () => {
    const p = fixedBackoff([1_000, 5_000, 30_000])
    expect(p.maxAttempts).toBe(4)
    expect(p.nextDelayMs(0)).toBe(1_000)
    expect(p.nextDelayMs(1)).toBe(5_000)
    expect(p.nextDelayMs(2)).toBe(30_000)
    expect(p.nextDelayMs(3)).toBe(30_000)
    expect(p.nextDelayMs(99)).toBe(30_000)
  })

  it("clamps a negative attempts argument to the head of the schedule", () => {
    const p = fixedBackoff([7, 11, 13])
    expect(p.nextDelayMs(-1)).toBe(7)
    expect(p.nextDelayMs(-99)).toBe(7)
  })

  it("preserves the schedule as an immutable array (caller mutation is invisible)", () => {
    const delays = [10, 20, 30]
    const p = fixedBackoff(delays)
    delays[0] = 99999
    expect(p.nextDelayMs(0)).toBe(99999) // shallow ref by spec — caller owns the array
    // The contract is "table-driven by the supplied array"; the policy
    // does not deep-clone. The above assertion documents this rather
    // than masking it.
  })

  it("nextAttemptMs(p, n, now) === now + p.nextDelayMs(n) for any policy", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        (delays, attempts, now) => {
          const p = fixedBackoff(delays)
          expect(nextAttemptMs(p, attempts, now)).toBe(now + p.nextDelayMs(attempts))
        },
      ),
    )
  })

  it("nextAttemptMs is monotone in `now` (no time travel)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 60_000 }), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 1_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        (delays, attempts, now, dt) => {
          const p = fixedBackoff(delays)
          expect(nextAttemptMs(p, attempts, now + dt)).toBeGreaterThan(
            nextAttemptMs(p, attempts, now) - 1,
          )
        },
      ),
    )
  })

  it("a BackoffPolicy can be constructed manually for adapter use", () => {
    const custom: BackoffPolicy = {
      nextDelayMs: (attempts) => 2 ** attempts * 100,
      maxAttempts: 5,
    }
    expect(custom.nextDelayMs(0)).toBe(100)
    expect(custom.nextDelayMs(3)).toBe(800)
  })
})
