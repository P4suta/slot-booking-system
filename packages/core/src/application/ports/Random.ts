import { Context, type Effect } from "effect"

/**
 * Pseudo-random number side effect, abstracted as an `Effect.Tag`.
 * Production wires `Random` to a non-deterministic source
 * (`Math.random` or `crypto.getRandomValues`); tests provide a
 * deterministic stream so jitter-aware policies become reproducible.
 *
 * Distinct from the `effect/Random` module to keep the port surface
 * narrow (`next: Effect<number>` returning `[0, 1)`) and to avoid
 * coupling consumers to the upstream's wider API.
 */
export class Random extends Context.Service<
  Random,
  {
    /**
     * Sample a fresh value uniformly from the half-open interval
     * `[0, 1)`. Each call advances the underlying generator's state.
     */
    readonly next: Effect.Effect<number>
  }
>()("@booking/core/Random") {}
