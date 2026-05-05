# 0011. `packages/core` distribution shape and cross-repo consumption

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: packaging, architecture

## Context

The repository contains the industry-agnostic core (`packages/core`) and a generic demo (`apps/default`). A future repository (`bikeshop-booking`) will deploy the core for an actual business and is intentionally split off (SYSTEM.md §4.5.1). We need to decide what `packages/core` ships now so the future repo can consume it without rework.

## Decision

`packages/core` is published as a **standard ESM package**:

- `package.json#type` = `"module"`.
- `package.json#exports` declares `.`, `./domain`, `./application` with both `import` and `types` conditions.
- `tsc -p tsconfig.build.json` emits `dist/**.js` + `dist/**.d.ts` (declaration maps included).
- `package.json#files` whitelists `dist/`, `README.md`, `LICENSE-*`. Source `src/` is **not** shipped.
- `package.json#sideEffects` = `false` so consumers tree-shake.
- `pnpm pack --pack-destination /tmp` followed by `node -e "import('./dist/index.js')"` from a clean container is part of the Phase 0 verification.

The choice of cross-repo distribution mechanism (npm publish vs Changesets vs git submodule vs GitHub Packages) is **deferred to Phase 2**, when `bikeshop-booking` is created. The current shape is compatible with all of those.

## Consequences

- `apps/default` consumes `@booking/core` via `workspace:*` and exercises the published shape every day, so the future bikeshop repo will not be the first consumer of the build artefacts.
- A premature decision on registry hosting (private npm? GitHub Packages? Changesets?) is avoided.
- Once the bikeshop repo is created, the next ADR (0011-followup or 00NN) will pin a distribution mechanism.

## Alternatives considered

- **Decide distribution now**: too speculative; today we have one consumer.
- **Ship `src/` only and let consumers `tsc`**: defeats `package.json#exports` and forces every consumer onto our toolchain.

## References

- SYSTEM.md §4.5.1.
- ADR-0008 (apps vs core layout).
