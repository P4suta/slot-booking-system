import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_EWMA_ALPHA,
  emptyMetric,
  type ServiceMetric,
  updateMetric,
} from "../../src/domain/queue/eta.js"
import { numRuns } from "../_arb/numRuns.js"

/**
 * EWMA invariants from ADR-0066 §EWMA.
 *
 *   - Bounded: the smoothed average stays inside `[min(obs), max(obs)]`
 *     for any observation sequence (the mean of a convex combination
 *     can never escape the convex hull of the inputs).
 *   - α = 0 ⇒ identity: subsequent observations are ignored, the
 *     first observation wins.
 *   - α = 1 ⇒ last-write-wins: the metric tracks the most recent
 *     observation exactly.
 *   - Sample count is monotone: each `updateMetric` call increments
 *     it by 1.
 */

const arbObservation: fc.Arbitrary<number> = fc.integer({ min: 100, max: 5 * 60 * 1000 })

const fold = (observations: readonly number[], alpha: number = DEFAULT_EWMA_ALPHA): ServiceMetric =>
  observations.reduce<ServiceMetric>((m, o) => updateMetric(m, o, alpha), emptyMetric)

describe("ADR-0066 EWMA — bounded smoothing", () => {
  it("avgServingMs stays within [min, max] of the observation list", () => {
    fc.assert(
      fc.property(fc.array(arbObservation, { minLength: 1, maxLength: 200 }), (obs) => {
        const metric = fold(obs)
        const lo = Math.min(...obs)
        const hi = Math.max(...obs)
        // ε for floating-point composition errors over up to 200 multiplies.
        const eps = 1e-6 * Math.max(hi, 1)
        expect(metric.avgServingMs).toBeGreaterThanOrEqual(lo - eps)
        expect(metric.avgServingMs).toBeLessThanOrEqual(hi + eps)
      }),
      { numRuns: numRuns(100, 400) },
    )
  })

  it("α = 0 ⇒ first observation wins (identity for subsequent observations)", () => {
    fc.assert(
      fc.property(fc.array(arbObservation, { minLength: 1, maxLength: 50 }), (obs) => {
        const metric = fold(obs, 0)
        expect(metric.avgServingMs).toBe(obs[0])
      }),
      { numRuns: numRuns(50, 200) },
    )
  })

  it("α = 1 ⇒ last-write-wins (the metric equals the most recent observation)", () => {
    fc.assert(
      fc.property(fc.array(arbObservation, { minLength: 1, maxLength: 50 }), (obs) => {
        const metric = fold(obs, 1)
        expect(metric.avgServingMs).toBe(obs[obs.length - 1])
      }),
      { numRuns: numRuns(50, 200) },
    )
  })

  it("sampleCount equals the number of updateMetric calls", () => {
    fc.assert(
      fc.property(fc.array(arbObservation, { minLength: 0, maxLength: 200 }), (obs) => {
        const metric = fold(obs)
        expect(metric.sampleCount).toBe(obs.length)
      }),
      { numRuns: numRuns(50, 200) },
    )
  })

  it("emptyMetric is the identity: updateMetric(emptyMetric, obs) takes obs verbatim", () => {
    fc.assert(
      fc.property(arbObservation, (obs) => {
        const metric = updateMetric(emptyMetric, obs)
        expect(metric.avgServingMs).toBe(obs)
        expect(metric.sampleCount).toBe(1)
      }),
      { numRuns: numRuns(50, 200) },
    )
  })
})
