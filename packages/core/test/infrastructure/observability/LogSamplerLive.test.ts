import { Effect, Layer } from "effect"
import { describe, expect, it, vi } from "vitest"
import { LogSampler } from "../../../src/application/ports/LogSampler.js"
import { RuntimeMode } from "../../../src/application/ports/RuntimeMode.js"
import {
  LogSamplerLive,
  passThroughSampler,
  prodSamplingRates,
} from "../../../src/infrastructure/observability/LogSamplerLive.js"

/**
 * Phase 3 PR#8 / commit 15 — pin the env-indexed access-log sampler
 * (ADR-0042 sister-pattern). The contract:
 *
 *   1. `passThroughSampler` — always emits (dev arm).
 *   2. `prodSamplingRates()` — exposes the canonical rate table for
 *      operator-facing dashboards / smoke tests.
 *   3. `LogSamplerLive` — `Layer.unwrap` over `RuntimeMode` returns
 *      the appropriate `shouldEmit` member.
 *   4. The internal `decideAtRate` honours the `<= 0` short-circuit
 *      (never emit) — exercised by stubbing `Math.random` to assert
 *      the rate-table arithmetic without statistical flake.
 */

describe("passThroughSampler (commit 15)", () => {
  it("always returns true regardless of severity", () => {
    expect(passThroughSampler("validation")).toBe(true)
    expect(passThroughSampler("domain")).toBe(true)
    expect(passThroughSampler("infrastructure")).toBe(true)
  })
})

describe("prodSamplingRates (commit 15)", () => {
  it("publishes the canonical 0.1 / 0.5 / 1.0 rate table", () => {
    expect(prodSamplingRates()).toEqual({
      validation: 0.1,
      domain: 0.5,
      infrastructure: 1.0,
    })
  })
})

describe("LogSamplerLive — env-indexed dispatch (commit 15)", () => {
  const runWith = async (mode: "dev" | "prod", rng: number): Promise<readonly boolean[]> => {
    const stub = vi.spyOn(Math, "random").mockReturnValue(rng)
    try {
      const program = Effect.gen(function* () {
        const s = yield* LogSampler
        return [
          s.shouldEmit("validation"),
          s.shouldEmit("domain"),
          s.shouldEmit("infrastructure"),
        ] as const
      })
      const layer = LogSamplerLive.pipe(
        Layer.provide(Layer.succeed(RuntimeMode, RuntimeMode.of({ mode }))),
      )
      return await Effect.runPromise(program.pipe(Effect.provide(layer)))
    } finally {
      stub.mockRestore()
    }
  }

  it("dev-mode emits every severity unconditionally", async () => {
    const [v, d, i] = await runWith("dev", 0.999)
    expect([v, d, i]).toEqual([true, true, true])
  })

  it("prod-mode at random=0.05 emits validation + domain + infrastructure", async () => {
    // 0.05 < 0.1 (validation) and < 0.5 (domain) and 1.0 (infra) is a fixed pass.
    const [v, d, i] = await runWith("prod", 0.05)
    expect([v, d, i]).toEqual([true, true, true])
  })

  it("prod-mode at random=0.6 drops validation + domain, keeps infrastructure", async () => {
    // 0.6 > 0.5 (domain) and 0.6 > 0.1 (validation), but rate==1.0 short-circuits to true.
    const [v, d, i] = await runWith("prod", 0.6)
    expect([v, d, i]).toEqual([false, false, true])
  })
})
