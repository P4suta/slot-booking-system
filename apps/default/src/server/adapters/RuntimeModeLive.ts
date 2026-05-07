import { RuntimeMode } from "@booking/core"
import { Layer } from "effect"

/**
 * Construct a {@link RuntimeMode} Layer from the worker `env`. The
 * binding key is `env.IS_DEV` — a string `"1"` switches to dev mode,
 * everything else (including missing) falls back to `"prod"`. The
 * matching wrangler config is:
 *
 *   ```toml
 *   [vars]
 *   IS_DEV = "0"
 *
 *   [env.dev.vars]
 *   IS_DEV = "1"
 *   ```
 *
 * `wrangler dev -e dev` therefore runs as `mode="dev"` and the
 * deployed worker(s) stay at `mode="prod"`. ADR-0042 details the
 * boolean ground truth choice (vs. multi-valued environment, vs.
 * `compatibility_date` introspection).
 */
export const makeRuntimeModeLayer = (env: { readonly IS_DEV?: string }): Layer.Layer<RuntimeMode> =>
  Layer.succeed(RuntimeMode, RuntimeMode.of({ mode: env.IS_DEV === "1" ? "dev" : "prod" }))
