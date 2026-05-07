import { RuntimeMode } from "@booking/core"
import { Layer } from "effect"

/**
 * Construct a {@link RuntimeMode} Layer from the worker `env`. The
 * binding key is `env.IS_DEV` — a string `"1"` switches to dev mode,
 * everything else (including missing) falls back to `"prod"`.
 *
 * `apps/default/wrangler.toml` keeps the top-level `[vars]` at
 * `IS_DEV = "0"` (deploy default), and the `dev` npm script adds
 * `--var IS_DEV:1` so `wrangler dev` runs in dev mode without
 * routing through a `[env.<name>]` block (wrangler v4 named envs
 * do not inherit `[vars]` / D1 / DO bindings, so the CLI override
 * is the simpler categorical lift). ADR-0042 details the boolean
 * ground-truth choice (vs. multi-valued environment, vs.
 * `compatibility_date` introspection).
 */
export const makeRuntimeModeLayer = (env: { readonly IS_DEV?: string }): Layer.Layer<RuntimeMode> =>
  Layer.succeed(RuntimeMode, RuntimeMode.of({ mode: env.IS_DEV === "1" ? "dev" : "prod" }))
