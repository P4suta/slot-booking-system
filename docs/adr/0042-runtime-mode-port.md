# ADR-0042 — RuntimeMode port

## Status

Phase 3 PR#8. **Accepted** — landed alongside the DX hardening
commit train (commits 1–9 of plan `validated-stargazing-karp.md`).
Successor adapters (`ErrorRedactionLive` from ADR-0043,
`LogSamplerLive` from the access-log plugin, the OTel exporter
triage) all read this port to choose dev vs. prod variants.

## Context

The worker had no first-class `dev` / `prod` discriminator. The
`@microlabs/otel-cf-workers` exporter URL was hard-coded to
`http://localhost:4318/v1/traces`, the GraphQL error path collapsed
every cause behind a synthetic `TransportError` envelope, and the
operation-log plugin (newly introduced) had no way to suppress
PII-bearing variables on production while keeping them visible in
dev. Each adapter would otherwise grow its own ad-hoc heuristic
(`compatibility_date` introspection, hostname checks, environment
sniffing through `process.env.*`).

ADR-0026 already establishes the principle that side-channel
selections happen at the port boundary. A boolean dev/prod tag is
the smallest such selection, but it must live in the Effect Context
so downstream code can swap it via `Layer.provide` from tests.

## Decision

Introduce a dedicated `RuntimeMode` port:

```ts
class RuntimeMode extends Context.Service<
  RuntimeMode,
  { readonly mode: "dev" | "prod" }
>()("@booking/core/RuntimeMode") {}
```

The shape is a plain record (no `Effect`-valued fields) so reads are
synchronous; downstream Layers compose via `Layer.unwrap`:

```ts
ErrorRedactionLive = Layer.unwrap(
  Effect.map(RuntimeMode, m =>
    Layer.succeed(ErrorRedaction, m.mode === "dev" ? devRedact : prodRedact))
)
```

This is the universal property of the env-indexed Layer family: a
function `RuntimeMode → Layer<R, never, A>` is the categorical
representation of a `Reader RuntimeMode (Layer<R, never, A>)`, and
`Layer.unwrap` is the bind of that Reader monad lifted into
the Layer space.

The construction site (`makeRuntimeModeLayer(env)`) lives in the
deployment, not in core — each app keys off whatever local signal
makes sense. For `apps/default` the signal is `env.IS_DEV === "1"`,
configured via wrangler:

```toml
[vars]
IS_DEV = "0"
```

…with the `dev` npm script overriding via the wrangler CLI:

```jsonc
"dev": "wrangler dev --ip 0.0.0.0 --test-scheduled --var IS_DEV:1 --var OTEL_EXPORTER_URL:console"
```

`wrangler dev` therefore sees `"1"`; `wrangler deploy` sees `"0"`.
We intentionally do **not** route through a `[env.<name>]` block —
wrangler v4's named environments do not inherit `[vars]`, D1, or
DO bindings, so the CLI override is the simpler categorical lift
(one place to look, no surprises across deploy targets). The
boolean is intentionally dumb — multi-valued environments
(`staging`, `canary`, …) will be modelled by separate ports if and
when needed, not by widening this union.

## Consequences

**Wins**:

- Adapters can switch on `mode === "dev"` without scraping the
  worker `env` directly. Tests provide a fixture Layer
  (`Layer.succeed(RuntimeMode, RuntimeMode.of({ mode: "dev" }))`)
  to exercise either branch deterministically.
- The dev/prod choice is concentrated in a single boolean evaluated
  once at worker boot. Renaming, swapping, or extending the tag
  changes one constructor.
- ADR-0026 invariant holds: every dependent port (Logger,
  ErrorRedaction, LogSampler, …) keeps its surface unchanged across
  modes — the variation is in the implementation only.

**Trade-offs**:

- Adding the port to core adds a Layer requirement for any
  downstream port that wants env-indexed implementations. The
  scheduled handler in `worker.ts` therefore needs to provide
  `RuntimeMode` alongside `Logger` / `Clock`. The cost is one extra
  `.pipe(Layer.provide(makeRuntimeModeLayer(env)))` per entry
  point, accepted as the price of the categorical cleanliness.
- The `IS_DEV` env var becomes a deploy-time contract — if a future
  deploy pipeline forgets to set it, the worker silently runs in
  prod mode. The default-to-prod posture is intentional (fail
  closed); a misconfigured local dev still works because
  `wrangler dev --var IS_DEV:1` is the documented entry point.

## Alternatives considered

1. **Compatibility-date introspection** — `env.WRANGLER_DEV` or
   parsing `compatibility_date` would have detected dev runs without
   adding an env var. Rejected because the heuristic would hide
   from tests (`vitest run` doesn't set `WRANGLER_DEV`) and would
   tie the dev signal to wrangler's internals.
2. **Multi-valued tag (`"local" | "staging" | "canary" | "prod"`)** —
   defers a decision (which adapter pairs with which environment)
   into the type system. Rejected because every adapter today only
   needs the dev/prod cleavage; widening early invents semantics
   the codebase doesn't yet have.
3. **Boolean field on every dependent port** — would push the env
   discriminator into Logger, ErrorRedaction, LogSampler
   independently. Rejected because the port surface would expand
   for every consumer; ADR-0026 explicitly forbids that growth
   pattern.

## References

- ADR-0026 — Logger / Clock port
- ADR-0017 — TaggedError + cause discipline (consumed by ErrorRedaction)
- ADR-0043 — ErrorRedaction port (the first downstream adopter)
