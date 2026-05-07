# Integration suite (Miniflare-backed, vitest-pool-workers)

This directory hosts integration tests that boot a workerd isolate per
test file via `@cloudflare/vitest-pool-workers` (`cloudflareTest()`
in `apps/default/vitest.integration.config.ts`).

**Status (2026-05-08): live.** The first test
(`doCrashRecovery.integration.test.ts`) asserts the transport-level
invariant that `ctx.storage.put` + `ctx.storage.sync()` survives
`ctx.abort()` — the production event-source replay precondition.

## Running

```bash
docker compose run --rm dev sh -c 'cd apps/default && corepack pnpm test:integration'
```

Workerd boot adds ~3-9s per file, so the suite is gated behind a
separate `pnpm test:integration` script. The fast inner loop
(`pnpm test`) runs the node-environment shape contracts in
`../effectRpc/`.

## Wiring notes

- **`cloudflareTest()` plugin** (not `cloudflarePool()` alone) wires
  the `cloudflare:test` virtual module via Vite's `resolveId` hook.
  `cloudflarePool()` alone only sets `poolRunner` and the virtual
  module never resolves at the test transform stage in vitest 4.
- **`main` override** points at `worker.entry.ts` instead of
  `src/worker.ts`. The production worker imports the full Yoga /
  Pothos schema build; for integration tests we only need the
  `DaySchedule` DO export, so the minimal entry sidesteps Pothos's
  Query reference resolution race.

## Adding tests

The pool config inherits the `wrangler.toml` bindings (`DAY_SCHEDULE`
DurableObject + `DB` D1). Tests import `env` and helpers like
`runInDurableObject` / `createExecutionContext` from
`cloudflare:test`. Each test file owns a fresh isolate, so tests do
not need to clean up state between files.
