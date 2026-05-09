# `just fuzz` — long-run property soak

Every `*.property.test.ts` under `packages/core/test/property/**`
plus the transitions ↔ projection homomorphism in
`test/domain/queue/homomorphism.test.ts` reads the `FC_NUM_RUNS`
env to override its per-property `numRuns`. The default short
loop (~30-200 iterations) is the tight inner-loop CI gate;
`just fuzz` lifts it to **10 000 iterations per property** so a
shrinker has enough budget to surface counterexamples.

## Run

```console
$ just fuzz
[fuzz] FC_NUM_RUNS=10000
 RUN  v4.x  /workspace/packages/core
 ✓ test/property/applyEvent-idempotency.property.test.ts (2 tests)  62.4s
 ✓ test/property/snapshot-delta-replay.property.test.ts  (2 tests)  61.2s
 ✓ test/property/concurrency-error-ordering.property.test.ts (2 tests) 73.9s
 ✓ test/property/log-pii.property.test.ts (1 test)              43.8s
 ✓ test/property/ticket-lifecycle.property.test.ts (1 test)     49.6s
[fuzz] ✓ all property assertions passed in 295s (10000 iterations / property)
```

The exit code matches the underlying vitest run — any single
property that shrinks to a falsifying input fails the recipe.

## Tune

```sh
FC_NUM_RUNS=2000 just fuzz   # quick 1-min smoke
FC_NUM_RUNS=50000 just fuzz  # 25-min deep soak
```

The properties' `dev` / `ci` defaults still apply when
`FC_NUM_RUNS` is unset (set by `just test-property` or CI). The
shared resolver lives at `packages/core/test/_arb/numRuns.ts`.

## Interpret

A failure in `just fuzz` that doesn't reproduce in `just test`
points to a code path the dev-loop iteration count missed —
typically a corner of a state-machine transition or a generator
with low natural-frequency inputs. Open the failing test's log:
fast-check prints the seed + the shrunk counterexample. Re-run
the single property with `--seed=<seed>` to reproduce
deterministically.

## Add a property

1. Place the new test under `packages/core/test/property/<topic>.property.test.ts`.
2. Import `numRuns` from `_arb/numRuns.js` and pass `numRuns(dev, ci)` to fc.assert.
3. The new property is auto-included by `pnpm -F @booking/core run test:property`
   (which globs `test/property/`).
