import { LogSampler, LogSamplerLive, prodSamplingRates, RuntimeMode } from "@booking/core"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

/**
 * `LogSamplerLive` — pin the env-indexed dispatch contract.
 *
 *   - dev mode: `shouldEmit` is always true (every line reaches the
 *     log sink for triage).
 *   - prod mode: `shouldEmit` consults a severity-indexed rate table
 *     (`prodSamplingRates()`). Rate=1 means always-true; rate=0 means
 *     always-false; the test asserts the boundary cases without
 *     depending on `Math.random` directly.
 *
 * The categorical claim being asserted: `Layer.unwrap` realises the
 * `Reader RuntimeMode (Layer LogSampler)` lift, so providing
 * different `RuntimeMode` values selects different `shouldEmit`
 * functions deterministically.
 */

const sampleUnder = (mode: "dev" | "prod") => {
  const program = Effect.gen(function* () {
    const sampler = yield* LogSampler
    return sampler
  })
  return Effect.runPromise(
    program.pipe(
      Effect.provide(LogSamplerLive),
      Effect.provide(Layer.succeed(RuntimeMode, RuntimeMode.of({ mode }))),
    ),
  )
}

describe("LogSamplerLive", () => {
  it("always emits every line in dev mode", async () => {
    const sampler = await sampleUnder("dev")
    expect(sampler.shouldEmit("validation")).toBe(true)
    expect(sampler.shouldEmit("domain")).toBe(true)
    expect(sampler.shouldEmit("infrastructure")).toBe(true)
  })

  it("always emits infrastructure failures in prod mode (rate=1)", async () => {
    const sampler = await sampleUnder("prod")
    // Run many trials — `infrastructure` rate is 1.0, so every trial
    // must succeed. A single false answer would already fail the
    // contract.
    for (let i = 0; i < 200; i += 1) {
      expect(sampler.shouldEmit("infrastructure")).toBe(true)
    }
  })

  it("samples validation logs at ~10% in prod mode", async () => {
    const sampler = await sampleUnder("prod")
    const trials = 5000
    let hits = 0
    for (let i = 0; i < trials; i += 1) {
      if (sampler.shouldEmit("validation")) hits += 1
    }
    const rate = hits / trials
    // 10% with a 5pp tolerance. Math.random() is the underlying RNG
    // (no seed control), so we use a generous band; with 5000 trials
    // the standard deviation is ~0.42pp, so 5pp is ~12σ — vanishingly
    // unlikely to flap.
    expect(rate).toBeGreaterThan(0.05)
    expect(rate).toBeLessThan(0.15)
  })

  it("exposes the prod rate table for diagnostic / docs reference", () => {
    const rates = prodSamplingRates()
    expect(rates.validation).toBe(0.1)
    expect(rates.domain).toBe(0.5)
    expect(rates.infrastructure).toBe(1.0)
  })
})
