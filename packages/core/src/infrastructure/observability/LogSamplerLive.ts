import { Effect, Layer } from "effect"
import { LogSampler } from "../../application/ports/LogSampler.js"
import { RuntimeMode } from "../../application/ports/RuntimeMode.js"
import type { ErrorSeverity } from "../../domain/errors/Errors.js"

/**
 * Severity-indexed sampling rates for prod. Rationale:
 *
 *   - `validation` is the highest-volume severity (every malformed
 *     phone, every empty kana surfaces here) and the operator only
 *     needs a representative sample to spot regressions.
 *   - `domain` failures (`PhoneMismatch`, `AlreadyCancelled`, …) are
 *     rarer but still operator-visible — half-sample so a regression
 *     spike still shows up.
 *   - `infrastructure` failures (`Storage`, `Concurrency`,
 *     `RpcClientError`) are always 100% — these are the failures
 *     the operator must never miss.
 *
 * Dev mode (the matching arm in `LogSamplerLive`) keeps the table at
 * 1.0 across the board so local triage sees every line.
 */
const PROD_RATES: Readonly<Record<ErrorSeverity, number>> = {
  validation: 0.1,
  domain: 0.5,
  infrastructure: 1.0,
}

/** Rate-based decision — a fresh `Math.random()` per call. */
const decideAtRate = (rate: number): boolean => {
  if (rate >= 1) return true
  // `Math.random() < rate` already short-circuits to `false` for any
  // `rate <= 0` (the RNG is in `[0, 1)` so the inequality cannot
  // hold). No separate guard needed — the strict inequality carries
  // both bounds.
  return Math.random() < rate
}

const devShouldEmit = (_severity: ErrorSeverity): boolean => true

const prodEmitter =
  (rates: Readonly<Record<ErrorSeverity, number>>) =>
  (severity: ErrorSeverity): boolean =>
    decideAtRate(rates[severity])

/**
 * Env-indexed adapter factory selecting `devShouldEmit` /
 * rates-based `prodEmitter` from the resolved {@link RuntimeMode}.
 * The selection is the categorical bind of
 * `Reader RuntimeMode (Layer LogSampler)` lifted through
 * `Layer.unwrap` (ADR-0042 / ADR-0043).
 *
 * Currying the prod rates lets a worker entrypoint feed env-derived
 * sampling rates (`LOG_SAMPLE_VALIDATION`, `LOG_SAMPLE_DOMAIN`,
 * `LOG_SAMPLE_INFRA`) into the layer at construction time without
 * baking the values into the source tree.
 */
export const makeLogSamplerLive = (
  prodRates: Readonly<Record<ErrorSeverity, number>>,
): Layer.Layer<LogSampler, never, RuntimeMode> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const m = yield* RuntimeMode
      return Layer.succeed(
        LogSampler,
        LogSampler.of({
          shouldEmit: m.mode === "dev" ? devShouldEmit : prodEmitter(prodRates),
        }),
      )
    }),
  )

/**
 * Default layer wired with {@link PROD_RATES}. Existing call sites
 * keep their `Effect.provide(LogSamplerLive)` shape; a worker that
 * needs env-driven rates calls `makeLogSamplerLive(envRates)`
 * instead.
 */
export const LogSamplerLive: Layer.Layer<LogSampler, never, RuntimeMode> =
  makeLogSamplerLive(PROD_RATES)

/**
 * Pure-passthrough sampler exported for test fixtures and the
 * synchronous yoga plugin chain. Mirrors the
 * `devRedactCause` / `prodRedactCause` standalone-export pattern
 * established by `ErrorRedactionLive`.
 */
export const passThroughSampler = devShouldEmit

/** Severity table accessor — exposed so tests can assert the rates. */
export const prodSamplingRates = (): Readonly<Record<ErrorSeverity, number>> => PROD_RATES
