import { Context } from "effect"

/**
 * Two-valued environment tag injected at the worker boundary. Adapters
 * key off `mode === "dev"` to choose verbose / fail-loud variants —
 * structured cause exposure on the GraphQL error path
 * (`ErrorRedactionLive`), full request-variable echo on the access log
 * (`LogSamplerLive`), `ConsoleSpanExporter` over a non-existent OTLP
 * collector — without leaking those affordances into production
 * deploys.
 *
 * Categorically: a singleton object equipped with the discrete topology
 * on `{"dev","prod"}`, lifted into the Effect `Context` through
 * `Service.of`. Downstream `Layer.unwrap(Effect.map(RuntimeMode,
 * m => m === "dev" ? devLayer : prodLayer))` realises the env-indexed
 * Layer family — ADR-0042 is the formal write-up.
 *
 * The constructor lives in `apps/<deployment>/src/server/adapters/`
 * (factory `makeRuntimeMode(env)`) so each deployment's wrangler env
 * binds the boolean `IS_DEV` once. ADR-0026 stays intact: the port
 * surface is unchanged regardless of mode.
 */
export class RuntimeMode extends Context.Service<
  RuntimeMode,
  {
    readonly mode: "dev" | "prod"
  }
>()("@booking/core/RuntimeMode") {}
