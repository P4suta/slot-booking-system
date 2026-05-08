import { env as rawEnv, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { DaySchedule } from "../../src/server/durableObjects/DaySchedule.js"

type IntegrationEnv = {
  readonly DAY_SCHEDULE: DurableObjectNamespace<DaySchedule>
  readonly DB: D1Database
  readonly DEPLOYMENT_NAME: string
  readonly DEPLOYMENT_TIMEZONE: string
  readonly SLOT_HMAC_SECRET: string
}

// `rawEnv` from cloudflare:test is deprecated in favour of
// `import { env } from "cloudflare:workers"`, but the test-side
// re-export still works under the pool runner; the cast records
// the IntegrationEnv shape without leaking the deprecated symbol
// further into the module surface.
// eslint-disable-next-line @typescript-eslint/no-deprecated
const env: IntegrationEnv = rawEnv as unknown as IntegrationEnv

/**
 * Phase 2.9 BI-10 — actual Miniflare-backed DO crash recovery.
 *
 * `runInDurableObject` boots a workerd isolate for the
 * `DAY_SCHEDULE` namespace, calls a DO method, simulates a restart
 * via `ctx.abort()`, then calls again to assert the runtime spins
 * up a fresh DO state. The persisted `ctx.storage` survives the
 * abort — the production event-source replay path rebuilds the
 * booking aggregate from these persisted events on next call.
 *
 * The DO body itself isn't asserted here — replay correctness is a
 * domain property covered by `BookingFromRow` round-trip + the
 * in-memory `BookingEventSourcedRepository` law tests. This file
 * pins the **transport-level** invariant: `ctx.abort` doesn't leak
 * in-memory state across DO instances under the workerd runtime,
 * but `ctx.storage.sync()`-committed writes survive.
 */
describe("DaySchedule DO — workerd-isolated crash recovery", () => {
  it("ctx.storage writes survive ctx.abort (event-source replay precondition)", async () => {
    const id = env.DAY_SCHEDULE.idFromName("2026-05-08")

    // First call: persist a value committed via ctx.storage.sync(),
    // then ctx.abort throws to tear down the DO instance. The
    // sync-committed write must survive (production event-source
    // replay relies on this — events are flushed before any
    // failure path can trigger).
    await expect(
      runInDurableObject(env.DAY_SCHEDULE.get(id), async (_instance, ctx) => {
        void ctx.storage.put("sentinel", { phase: "before-abort" })
        await ctx.storage.sync()
        ctx.abort("test-induced restart")
      }),
    ).rejects.toThrow("test-induced restart")

    // Second call: a fresh stub for the same id boots a new DO
    // instance — the prior in-memory FiberRef is gone, but the
    // persisted ctx.storage survives. This is the precondition for
    // event-source replay rebuilding the booking aggregate after a
    // production crash.
    const after = await runInDurableObject(env.DAY_SCHEDULE.get(id), async (_instance, ctx) =>
      ctx.storage.get("sentinel"),
    )
    expect(after).toEqual({ phase: "before-abort" })
  })
})
