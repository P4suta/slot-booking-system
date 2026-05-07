# ADR-0039 Effect 4 + drizzle-orm 1 migration retrospective (Phase 2.2)

## Status

Accepted (2026-05-08).

## Context

`docs/migration/effect-4.md` (Phase 2.2 / BI-10) had been deferred since
2026-05-06 with `effect@4.0.0-beta.60` + `drizzle-orm@1.0.0-rc.2`
producing 1224 type errors on first attempt. Re-start was gated behind
**any one** of: effect 4 stable release, `@pothos/plugin-errors`
Effect-4 build, or **the team accepting the cost of a dedicated
multi-day session**. The third clause fired in the 2026-05-07/08
session under the "everything still left, autonomously" mandate.

The user further refined the dependency-pinning policy mid-session:
**every** project dependency tracks its dist-tag latest (no exact
semvers). For non-stable channels we follow the channel tag itself
(`effect: "beta"` → 4.0.0-beta.62, `drizzle-orm: "rc"` → 1.0.0-rc.2).
For stable deps we use the `latest` literal. pnpm resolves at install
time; the lockfile pins the resolved versions for reproducibility.

## Decision

Migrate Effect 3.21 → Effect 4 (beta) + drizzle-orm 0.45 → 1.0 (rc) in
one mega-commit (`refactor(all): Effect 4 + drizzle 1 (BI-10 mega)`,
98 files, +1344/-1826 LoC). Subsequent two commits close ADR-0037 +
ADR-0038 carry-overs.

### Migration surface (per-Cat tally, post-migration)

| Cat | Effect 3 form | Effect 4 form | Sites |
|-----|---------------|---------------|-------|
| A | `Schema.TaggedError<...>()(...)` | `Schema.TaggedErrorClass<...>()(...)` | 33 |
| B | `Schema.Schema.Encoded<S>` | `Schema.Codec.Encoded<S>` | ~57 |
| (B') | `Schema.Schema.Type<S>` | unchanged (Schema namespace retains it) | — |
| C | `Schema.Literal(a, b, c)` (variadic) | `Schema.Literals([a, b, c])` | 7 |
| D | `Schema.Union(A, B, C)` (variadic) | `Schema.Union([A, B, C])` | 6 |
| E | `Schema.transform(s1, s2, …)` | `s1.pipe(Schema.decodeTo(s2, { decode: SchemaGetter.transform(…) }))` | 7 |
| (E') | `Schema.transformOrFail(…)` | `decodeTo + SchemaGetter.transformOrFail` returning `Effect<T, Issue>` | 5 |
| F | `Schema.between(a, b)` / `Schema.filter(p)` | `Schema.check(Schema.isBetween({ minimum, maximum }))` / `Schema.check(Schema.makeFilter(p))` | 9 |
| G | `Schema.decodeUnknownEither` | `Schema.decodeUnknownResult` | ~37 |
| H | `Context.Tag(key)<Self, Shape>()` | `Context.Service<Self, Shape>()(key)` | 7 ports |
| I | `Schema.pattern(re)` | `Schema.check(Schema.isPattern(re))` | 6 brands |
| J | `Schema.int()` | `Schema.isInt()` (filter, used with `.check(...)`) | 4 sites |
| K | `Schema.BigIntFromSelf` | `Schema.BigInt` | 1 site |
| L | `Schema.Schema<T, E>` (2-arg) | `Schema.Codec<T, E>` (4-arg, but 2-arg infers) | 9 sites |
| M | `Schema.encodedSchema(...)` | `Schema.toEncoded(...)` | 4 sites |
| N | `Either` module | `Result` module (succeed/fail/isSuccess/isFailure/mapError) | 55 files |
| O | `Effect.either(eff)` | `Effect.result(eff)` | 9 sites |
| P | `Effect.catchAll` / `catchAllDefect` / `ignoreLogged` / `zipRight` | `Effect.catch` / `catchDefect` / `ignore` / `flatMap` | scattered |
| Q | `@effect/rpc` import | `effect/unstable/rpc` | router/client/handlers/runner |
| R | `Effect.flatMap(Tag, fn)` | `Effect.flatMap(Effect.service(Tag), fn)` | tests |
| S | `Context.Tag.Service<typeof X>` | `Context.Service.Shape<typeof X>` | tests |
| T | `Effect.Effect.Success<T>` | `Effect.Success<T>` | tests |
| U | STM / TMap | `Ref<HashMap>` (per-entity) or `Ref<Store>` (atomic across maps) | 2 in-memory adapters |
| V | `ParseResult.TreeFormatter` | `SchemaIssue.makeFormatterDefault()` | fromParseError.ts |
| W | `Arbitrary.make(s)` | `Schema.toArbitrary(s)` | derive/index.ts |
| X | `Schema.declare(... { arbitrary: ... })` annotation key | renamed to `toArbitrary` | Temporal.ts |
| Y | `RpcClientError({ reason: string })` | `RpcClientError({ reason: new RpcClientDefect({...}) })` (typed reason) | client.ts |
| Z | `decodeTo` transform direction (`From.Type → To.Encoded`) — incompatible with `Type-only` row codec → introduce per-variant `*Domain` Type-only Schemas | BookingRow.ts | 5 arms |

### Pothos compatibility — confirmed PASS

The deferred ADR-0038 carry-over flagged `@pothos/core@4.12 +
@pothos/plugin-errors@4.9` Effect-4 compatibility as an open question.
The session-2 spike (`worktree`, deps bump only, minimum surgery)
showed **0 errors originating in `@pothos/*` packages** — Pothos has no
`effect` peer-dep, so Effect 4 doesn't break it. Pothos shape
derivation stays as-is (catalog.ts type aliases off
`Schema.Codec.Encoded<typeof *FromRow>`).

### Architectural adjustments

1. **`InMemoryEventSourcedRepositoryLive` rewrite** (Effect 4 removed
   STM/TMap). Single `Ref<Store>` collapses the three TMaps into one
   atomic boundary; `Ref.modify` resolves the optimistic-concurrency
   `expected → current` revision check inside the closure, returning
   either the new store or signalling `ConcurrencyError`. Same
   correctness contract, simpler surface.

2. **`InMemoryServiceCatalogLive` rewrite** — six per-entity
   `Ref<HashMap>` instances; cross-entity transactions were never part
   of the contract (the use-case layer composes them), so the per-row
   atomicity from `Ref.update` is sufficient.

3. **`derive/index.ts` principled tree walk** — Effect 4's flat
   `Checks` tuple replaces Effect 3's nested `Refinement`/`Transformation`
   AST nodes. The pattern extractor now reads `Filter.annotations.meta._tag === "isPattern"` directly off the `ast.checks` array — one
   pass, no recursion.

4. **`BookingRow.ts` discriminated coproduct decoder** — Effect 4's
   `decodeTo(to, transform)` runs `transform.decode: From.Type → To.Encoded`
   (i.e., it pre-encodes the target). To preserve a Type-only slot
   transformation (no `Instant ↔ ISO-string` round-trip detour), we
   introduce per-variant `*Domain` Schemas defined locally to BookingRow
   over `InstantSelf` (the Type-only declare). The discriminated
   coproduct decoder structure (one fiber per `state` literal) is
   preserved; only the inner Schema reference differs from
   `Booking.ts`'s domain variants.

5. **`getCurrentTraceId` ground truth shift** (ADR-0038 carry-over A,
   resolved C1 in the prior pass): replaced FiberRef with
   `Effect.currentSpan` + new `traceIdFromHex(hex)` re-encoder.
   `CurrentTraceId` / `withTraceId` / `mintTraceId` were never seeded
   in production — verified empirically before deletion.

### Pin policy

`packages/core` and `apps/default` deps switched to dist-tag literals:

```jsonc
// packages/core/package.json
"dependencies": {
  "@js-temporal/polyfill": "latest",
  "effect": "beta",     // resolves to 4.0.0-beta.62 today
  "typeid-js": "latest",
  "ulidx": "latest"
}

// apps/default/package.json
"dependencies": {
  "@booking/core": "workspace:*",
  "@microlabs/otel-cf-workers": "latest",
  "@opentelemetry/api": "latest",
  "@pothos/core": "latest",
  "@pothos/plugin-errors": "latest",
  "drizzle-orm": "rc",  // resolves to 1.0.0-rc.2
  "effect": "beta",
  // ...
}
```

`pnpm install --no-frozen-lockfile` re-resolves the dist-tags;
`--frozen-lockfile` (CI) replays from `pnpm-lock.yaml`.

## Consequences

### Positive

- BI-10 (Phase 2.2) closed. Phase 2 fully complete (12/12 BI).
- 482 + 3 = 485 tests pass; lint, typecheck, dead-code, type-coverage,
  arch, strict-code, pii-guard, domain-purity all green.
- `Schema.transformOrFail` → `decodeTo + SchemaGetter.transformOrFail`
  returning `Effect<T, SchemaIssue.Issue>` — fallible decoders are now
  Effect-native, no longer threading through `ParseResult` callbacks.
- `Ref<Store>` collapse: in-memory event repository simpler than the
  STM implementation it replaces, with the same correctness contract.
- Pothos shape derivation now compiles against Effect 4 with no
  bridge layer.

### Negative

- effect 4 in beta means the API may still churn before 4.0.0
  stable. Pin tracks the `beta` dist-tag, so we follow upstream.
- drizzle-orm 1.0 in rc — same. The `drizzle-orm/effect-schema`
  submodule is shipped but `createSelectSchema(table)` integration
  with the BI-10 SoT factor (`entityFromRow`) is **not yet wired**;
  the 6 catalog entities still keep Domain Schema as the runtime
  decoder. The factor is a follow-up in Phase 2.9 once both deps
  cross stable.
- BookingRow has duplicate variant Schemas (one per state, in
  `Booking.ts` for the wire codec and in `BookingRow.ts` for the
  Type-only row codec) — necessary because Effect 4's `decodeTo`
  insists on going through `To.Encoded` form. A future refactor
  could fold them once `Schema.typeCodec` (or equivalent) lands
  upstream.
- ADR-0037 carry-over (DO crash recovery via vitest-pool-workers +
  `runInDurableObject`) ships as a node-environment shape contract;
  the full Miniflare integration is gated behind a Phase 2.9
  `test/integration/` suite.

### Decision criteria for re-pinning to stable

When `effect@4.0.0` (stable) is published:

1. `corepack pnpm view effect dist-tags` confirms `latest === 4.0.0`
   and `beta` lags or matches.
2. Bump `effect: "beta"` → `effect: "latest"` in both
   `packages/core/package.json` and `apps/default/package.json`.
3. `corepack pnpm install --no-frozen-lockfile` re-resolves.
4. Same for `drizzle-orm: "rc"` → `drizzle-orm: "latest"` once
   `drizzle-orm@1.0.0` ships.

The **goal**: under one month after upstream stable, both pins move
off the channel tag.

## References

- Plan: `~/.claude/plans/lovely-drifting-galaxy.md` (BI-10 + carry-overs)
- Pre-migration drift catalogue: memory `reference_effect4_drift_catalogue.md`
- Pre-migration deferral: `docs/migration/effect-4.md` (now superseded
  by this ADR; kept as historical notes).
- Mega-commit: `c172e71` `refactor(all): Effect 4 + drizzle 1 (BI-10 mega)`
- Carry-over closure: `4e59a4b` `test(default): OTel span emission + DO crash recovery`
- Tag: `bi-10-mega` (commit `c172e71`).
