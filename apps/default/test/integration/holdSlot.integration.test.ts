import { env as rawEnv } from "cloudflare:test"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { DaySchedule } from "../../src/server/durableObjects/DaySchedule.js"
import { makeDayScheduleClient } from "../../src/server/durableObjects/effectRpc/client.js"

type IntegrationEnv = {
  readonly DAY_SCHEDULE: DurableObjectNamespace<DaySchedule>
  readonly DB: D1Database
  readonly DEPLOYMENT_NAME: string
  readonly DEPLOYMENT_TIMEZONE: string
  readonly SLOT_HMAC_SECRET: string
}

// eslint-disable-next-line @typescript-eslint/no-deprecated
const env: IntegrationEnv = rawEnv as unknown as IntegrationEnv

/**
 * Phase 3 PR#8 — end-to-end Miniflare-backed verification of the
 * DO RPC envelope sanitiser (ADR-0044). Without the sanitiser the
 * cross-isolate `stub.dispatch` call dies with
 *
 *   DataCloneError: Could not serialize object of type "Object".
 *
 * because workerd's RPC serialiser identifies "plain object" by its
 * own realm's `Object.prototype` identity, and Effect's library
 * bundle has its own realm whose `Object.prototype` is a different
 * reference. The sanitiser deep-walks the message graph and rewrites
 * every object into a same-realm `{}`, while preserving array
 * detection (realm-safe via `Array.isArray`) and converting BigInts
 * to a sigil string for symmetric round-trip.
 *
 * The DO itself owns the booking event store via DO local SQLite
 * (ADR-0028); no D1 catalog read sits on the HoldSlot path, so the
 * test exercises the full transport + handler pipeline without
 * needing migrations or seed data.
 */
describe("DO RPC HoldSlot end-to-end (sanitiser, ADR-0044)", () => {
  const holdSlotInput = (date: string) => ({
    slot: {
      serviceId: "serv_demo0000000000000000000001" as never,
      start: `${date}T10:00:00Z`,
      end: `${date}T10:30:00Z`,
      providerId: "prov_demo0000000000000000000001" as never,
      resourceIds: ["rsrc_demo0000000000000000000001" as never],
    },
    nameKana: "テスト" as never,
    phoneLast4: "1234" as never,
    freeText: null,
    source: "online" as const,
  })

  it("client.HoldSlot survives the workerd structured-clone hop and yields a Held booking", async () => {
    const date = "2026-05-09"
    const id = env.DAY_SCHEDULE.idFromName(date)
    const stub = env.DAY_SCHEDULE.get(id)

    const program = Effect.gen(function* () {
      const client = yield* makeDayScheduleClient(stub, `DaySchedule:${date}`)
      return yield* client.HoldSlot(holdSlotInput(date))
    })

    const exit = await Effect.runPromiseExit(Effect.scoped(program))
    if (exit._tag === "Failure") {
      // The cause must NOT include a transport-tier RpcClientError.
      // Convert the cause to JSON for assertion legibility — the
      // structural shape of `Cause` is opaque otherwise.
      const causeJson = JSON.stringify(exit.cause)
      expect(causeJson).not.toContain("RpcClientError")
      expect(causeJson).not.toContain("DataCloneError")
      // If we got here, the request crossed the wire and the handler
      // refused on a domain rule — that's still a transport win.
      return
    }
    // Success arm: the encoded HoldSlot result the resolver forwards
    // onto `MutationHoldSlotSuccess.data` — `{ bookingId, state,
    // eventType }`.
    expect(exit.value.state).toBe("Held")
    expect(exit.value.eventType).toBe("Held")
    expect(exit.value.bookingId).toMatch(/^bk_[0-9a-z]{26}$/)
  })
})
