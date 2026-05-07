# Integration suite (Miniflare-backed, vitest-pool-workers)

This directory hosts integration tests that boot a workerd isolate per
test file via `@cloudflare/vitest-pool-workers` (`cloudflarePool(...)`
in `apps/default/vitest.integration.config.ts`).

**Status (2026-05-08): scaffold only.** The dep + config + pnpm script
are wired, but `cloudflare:test`'s `runInDurableObject` import resolves
in node land before vitest's poolRunner kicks in (vitest 4 +
vitest-pool-workers 0.16 incompatibility — the pool registers
`cloudflare:test` as a virtual module but vitest 4's transform pipeline
doesn't yet honour the registration). The first integration test will
land once one of:

- vitest-pool-workers ships a vitest-4-compatible release that
  registers `cloudflare:test` as a virtual module via vitest's
  pool plugin lifecycle
- vitest 4 stabilises a public `poolRunner` extension API that the
  pool can hook into for module resolution

Until then, the OTel shape contracts in `../effectRpc/` cover the
node-level invariants and the in-memory `BookingEventSourcedRepository`
property tests (`packages/core/test/property/`) cover the domain-level
correctness of event-source replay.

When the upstream gap closes, the first test under this directory
will assert: a held booking persists across `ctx.abort()` (via
`runInDurableObject`), and the replayed snapshot emits the same OTel
span shape on the second dispatch as the first.

Run when ready: `pnpm -F default test:integration`.
