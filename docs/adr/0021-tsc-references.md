# 0021. tsc Project References for src ↔ test isolation

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: build, tsc, performance

## Context

Phase 0 typecheck ran `tsc --noEmit` once over `src/**/*` ∪
`test/**/*` per package. The single tsconfig made cold builds simple
but warm rebuilds had no granularity: editing a test forced a full
re-typecheck of the source tree, and editing the source forced a
full re-typecheck of the test tree.

`tsc -b` (Project References) introduces per-project incremental
caches. With src split from test, editing tests skips the src
re-check entirely, and editing src invalidates only the depending
test cache.

## Decision

Each package owns three tsconfigs:

| File | Role |
|---|---|
| `tsconfig.json` | thin orchestrator: empty `files`, `references` to src + test |
| `tsconfig.src.json` | `composite: true`, `emitDeclarationOnly: true`, `outDir: dist`, `rootDir: src` |
| `tsconfig.test.json` | `noEmit: true`, `references: [{ path: "./tsconfig.src.json" }]`, includes `test/**/*` |

The repo root `tsconfig.json` references `packages/core` and
`apps/default`. `tsc -b` from the root walks the graph and rebuilds
only what changed.

`apps/default/tsconfig.json` references
`../../packages/core/tsconfig.src.json` so editing the core
invalidates the app's cache without rebuilding the core test cache.

`Justfile typecheck` and the lefthook pre-push `typecheck` step both
run `./node_modules/.bin/tsc -b --pretty`. Per-package `tsc --noEmit`
(`pnpm -r exec tsc --noEmit`) is no longer used.

`packages/core/tsconfig.build.json` (used by
`pnpm -F @booking/core run build`) is unchanged — it produces JS
+ d.ts in `dist` for distribution and now declares a reference to
`tsconfig.src.json` so downstream incremental builds get the cache.

## Consequences

- **Pros**: warm rebuilds drop from full-package O(seconds) to
  per-project O(ms). Editing a test never re-typechecks src.
- **Cons**: three tsconfigs per package instead of one. Setup
  documented here so future contributors don't re-flatten it.
- **Cache hygiene**: `.tsbuildinfo` and `.tsbuildinfo.test` files
  are gitignored under `.tsbuildinfo*` / `**/.tsbuildinfo*`.

## Alternatives considered

- **Single tsconfig** (Phase 0 status quo): simpler config, slower
  warm rebuilds.
- **`tsc --build` against a single composite tsconfig**: no
  src/test isolation; defeats the per-cache benefit.
- **Bun's typecheck**: faster but not yet integrated with our
  Vitest type-test pipeline (`expectTypeOf`).

## References

- ADR-0008 (apps vs core layout).
- Step 11 (Project References re-introduction).
- TypeScript handbook: Project References.
