# `just fuzz` — long-run property soak

Every `*.property.test.ts` under `packages/core/test/property/**`
plus the transitions ↔ projection homomorphism in
`test/domain/queue/homomorphism.test.ts` reads the `FC_NUM_RUNS`
env to override its per-property `numRuns`. The default short
loop (~30-200 iterations) is the tight inner-loop CI gate;
`just fuzz` lifts it to **100 000 iterations per property** so a
shrinker has enough budget to surface counterexamples that only
emerge under skewed input distributions.

The per-property vitest `--test-timeout` scales with `FC_NUM_RUNS`
(`5 ms / iter + 30 s baseline`) so a 100 k or 1 M run won't hit
the default 5 s wall-clock cap.

## Run

```console
$ just fuzz
[fuzz] FC_NUM_RUNS=100000 testTimeout=530000ms
 ✓ test/property/concurrency-error-ordering.property.test.ts  …    7.4 s
 ✓ test/property/snapshot-delta-replay.property.test.ts       …    9.7 s
 ✓ test/property/applyEvent-idempotency.property.test.ts      …   12.0 s
 ✓ test/property/ticket-lifecycle.property.test.ts            …   19.8 s
 ✓ test/property/log-pii.property.test.ts                     …   40.2 s
[fuzz] ✓ all property assertions passed in 41s (100000 iterations / property)
```

The exit code matches the underlying vitest run — any single
property that shrinks to a falsifying input fails the recipe.

## Tune

```sh
FC_NUM_RUNS=10000 just fuzz   # quick smoke (≈ 6 s)
FC_NUM_RUNS=1000000 just fuzz # deep soak (≈ 7 min)
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
