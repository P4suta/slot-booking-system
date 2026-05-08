/**
 * Phase 2.9 BI-10 — minimal worker entry for the integration test
 * isolate. Only exports the `DaySchedule` DurableObject so the pool
 * can register its namespace; the production GraphQL surface
 * (Yoga / Pothos / resolver imports) is **not** loaded here.
 *
 * The integration test only exercises DO transport-level
 * invariants (`runInDurableObject`, `ctx.storage` round-trip). The
 * GraphQL pipeline is covered by node-environment shape contracts.
 */
export { DaySchedule } from "../../src/server/durableObjects/DaySchedule.js"

// Stub fetch handler — the integration suite never sends HTTP
// requests; the worker just needs to satisfy ExportedHandler.
export default {
  fetch(): Response {
    return new Response("integration-test stub", { status: 200 })
  },
} satisfies ExportedHandler
