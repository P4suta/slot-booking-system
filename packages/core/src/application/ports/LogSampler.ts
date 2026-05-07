import { Context } from "effect"
import type { ErrorSeverity } from "../../domain/errors/Errors.js"

/**
 * Decide whether a {@link LogPayload} carrying a given severity
 * should reach the sink. The implementation is selected by
 * {@link RuntimeMode}: dev passes everything (cap-free), prod applies
 * a severity-indexed rate so high-volume validation traffic does not
 * crowd out infrastructure failures in Workers Logs.
 *
 * The categorical shape: a function `ErrorSeverity → Bool` lifted
 * into `Context.Service`. Adapters compose via the env-indexed
 * `LogSamplerLive` Layer (`Reader RuntimeMode (Layer LogSampler)`
 * via `Layer.unwrap`).
 *
 * The sampling rates live in `LogSamplerLive`'s closures, not in
 * this port surface — keeping the port a one-method `shouldEmit`
 * means future tuning (per-deployment overrides, time-of-day
 * weighting, head-based sampling) lands as a new adapter without
 * disturbing call sites.
 */
export class LogSampler extends Context.Service<
  LogSampler,
  {
    readonly shouldEmit: (severity: ErrorSeverity) => boolean
  }
>()("@booking/core/LogSampler") {}
