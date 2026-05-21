import { reset, runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { pushKindFor } from "../../../src/server/durableObjects/QueueShop.js"
import { worker } from "../_harness/httpFixture.js"
import { staffHeaders } from "../_harness/jwtFixture.js"
import { getShopStub, inShopDo } from "../_harness/queueShopHarness.js"
import * as req from "../_harness/sample-requests.js"

/**
 * ADR-0072 / ADR-0075 four-tick alarm sweep — integration coverage
 * for the QueueShop DO's `alarm()` method:
 *
 *   - Tick 1: Called → Overdue when `now - calledAt > OVERDUE_AFTER_CALLED_SECONDS`
 *   - Tick 2: Overdue → Nudge (channel "ws", since no push subs)
 *   - Tick 3: Overdue → NoShow after MAX_NUDGES nudges
 *   - Tick 4: Waiting + reservation past `appointmentAt + grace` → Cancelled
 *
 * The test runs against the integration harness so the SqlStorage
 * predicates the alarm uses match what production sees. We backdate
 * timestamps directly via SQL to exercise the sweep without sleeping
 * for the real-world thresholds.
 */

const SECRET = "dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef"
const validHandle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }
const SAMPLE_KANA = "ヨヤク タロウ"
const SAMPLE_LAST4 = "5678"

const issueTicket = async (handle: { nameKana: string; phoneLast4: string }): Promise<string> => {
  const res = await worker().fetch(req.issueTicket({ handle, freeText: null }))
  const body: { ticket: { id: string } } = await res.json()
  return body.ticket.id
}

const callNext = async () => {
  const auth = await staffHeaders(SECRET)
  await worker().fetch(req.callNext(auth.bearerHeaders))
}

const backdate = async (
  ticketId: string,
  cols: { calledAt?: string; lastNudgedAt?: string; nudgeCount?: number; appointmentAt?: string },
) => {
  await inShopDo((_inst, state) => {
    if (cols.calledAt !== undefined) {
      state.storage.sql.exec(
        "UPDATE tickets SET called_at = ? WHERE id = ?",
        cols.calledAt,
        ticketId,
      )
    }
    if (cols.lastNudgedAt !== undefined) {
      state.storage.sql.exec(
        "UPDATE tickets SET last_nudged_at = ? WHERE id = ?",
        cols.lastNudgedAt,
        ticketId,
      )
    }
    if (cols.nudgeCount !== undefined) {
      state.storage.sql.exec(
        "UPDATE tickets SET nudge_count = ? WHERE id = ?",
        cols.nudgeCount,
        ticketId,
      )
    }
    if (cols.appointmentAt !== undefined) {
      state.storage.sql.exec(
        "UPDATE tickets SET appointment_at = ? WHERE id = ?",
        cols.appointmentAt,
        ticketId,
      )
    }
  })
}

const readState = async (ticketId: string): Promise<string> =>
  inShopDo((_inst, state) => {
    const rows = state.storage.sql
      .exec("SELECT state FROM tickets WHERE id = ?", ticketId)
      .toArray()
    return (rows[0]?.state as string | undefined) ?? "missing"
  })

const fireAlarm = async (): Promise<void> => {
  // `runInDurableObject` exposes the DO instance; the harness's
  // `getShopStub` is fine for surface calls but we want the
  // private `alarm()` method.
  const stub = getShopStub()
  await runInDurableObject(stub, async (instance) => {
    // The DurableObject's `alarm()` is a public override; cast to
    // `unknown` to bypass TS visibility for the test surface.
    await (instance as unknown as { alarm: () => Promise<void> }).alarm()
  })
}

const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const wayInThePast = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

afterEach(async () => {
  await reset()
})

describe("QueueShop alarm sweep (4 ticks, ADR-0072 / ADR-0075)", () => {
  it("Tick 1: a stale Called ticket transitions to Overdue", async () => {
    const id = await issueTicket(validHandle)
    await callNext()
    expect(await readState(id)).toBe("Called")
    await backdate(id, { calledAt: longAgo })
    await fireAlarm()
    expect(await readState(id)).toBe("Overdue")
  })

  it("Tick 2: an Overdue ticket with no pending nudge receives one (channel: ws)", async () => {
    const id = await issueTicket(validHandle)
    await callNext()
    await backdate(id, { calledAt: longAgo })
    await fireAlarm() // → Overdue, nudgeCount=0
    expect(await readState(id)).toBe("Overdue")
    // Re-arm precondition: lastNudgedAt is NULL initially, so Tick 2
    // fires on the very next alarm.
    await fireAlarm()
    const row = await inShopDo(
      (_inst, state) =>
        state.storage.sql
          .exec("SELECT nudge_count, last_nudged_at FROM tickets WHERE id = ?", id)
          .toArray()[0],
    )
    expect(Number(row?.nudge_count ?? 0)).toBe(1)
    expect(typeof row?.last_nudged_at).toBe("string")
  })

  it("Tick 3: an Overdue ticket at MAX_NUDGES transitions to NoShow on the next sweep", async () => {
    const id = await issueTicket(validHandle)
    await callNext()
    await backdate(id, { calledAt: longAgo })
    await fireAlarm() // Called → Overdue
    // Synthesise the post-MAX_NUDGES state: nudge_count=3 (default
    // MAX_NUDGES) with the last nudge backdated past one interval.
    await backdate(id, { nudgeCount: 3, lastNudgedAt: longAgo })
    await fireAlarm()
    expect(await readState(id)).toBe("NoShow")
  })

  it("Tick 4: a Waiting reservation past appointmentAt+grace is auto-cancelled (appointment_lapsed)", async () => {
    const auth = await staffHeaders(SECRET)
    void auth
    // Issue a reservation-lane ticket in the past.
    const res = await worker().fetch(
      req.issueTicket({
        handle: { nameKana: SAMPLE_KANA, phoneLast4: SAMPLE_LAST4 },
        freeText: null,
        lane: "reservation",
        appointmentAt: wayInThePast,
      }),
    )
    expect(res.status).toBe(201)
    const body: { ticket: { id: string } } = await res.json()
    const id = body.ticket.id
    expect(await readState(id)).toBe("Waiting")
    await fireAlarm()
    expect(await readState(id)).toBe("Cancelled")
    const reason = await inShopDo((_inst, state) => {
      const rows = state.storage.sql.exec("SELECT reason FROM tickets WHERE id = ?", id).toArray()
      return (rows[0]?.reason as string | undefined) ?? ""
    })
    expect(reason).toBe("appointment_lapsed")
  })

  // T5 regression lock — confirm Tick 2 + Tick 3 don't run in the
  // SAME alarm() call: after Tick 2 advances nudge_count to MAX_NUDGES,
  // Tick 3's `last_nudged_at <= cutoff` predicate is false because
  // last_nudged_at = now > now - nudgeInterval. The customer gets at
  // least one full interval to react before NoShow.
  //
  // We can't shortcut via a SQL UPDATE to `nudge_count` because the
  // Nudge use-case loads its source state from the event log, not
  // the projection. So we drive the counter forward by firing the
  // alarm three times, backdating `last_nudged_at` between fires so
  // Tick 2's "interval elapsed" predicate stays true.
  it("Tick 3 does not fire in the same alarm() as the final Tick 2 nudge", async () => {
    const id = await issueTicket(validHandle)
    await callNext()
    await backdate(id, { calledAt: longAgo })
    await fireAlarm() // → Overdue (nudgeCount=0)
    // Drive nudgeCount from 0 → 1 → 2 → 3 (MAX_NUDGES default).
    await fireAlarm() // → Nudge #1 (nudgeCount=1)
    await backdate(id, { lastNudgedAt: longAgo })
    await fireAlarm() // → Nudge #2 (nudgeCount=2)
    await backdate(id, { lastNudgedAt: longAgo })
    await fireAlarm() // → Nudge #3 (nudgeCount=3 = MAX_NUDGES)
    // After the final Tick 2 (Nudge #3), `last_nudged_at` is fresh
    // (≈ milliseconds ago), so Tick 3's `last_nudged_at <= cutoff`
    // predicate is false in this same alarm() — NoShow does NOT fire.
    expect(await readState(id)).toBe("Overdue")
    const row = await inShopDo(
      (_inst, state) =>
        state.storage.sql.exec("SELECT nudge_count FROM tickets WHERE id = ?", id).toArray()[0],
    )
    expect(Number(row?.nudge_count ?? 0)).toBe(3)
  })
})

// FP-3 regression lock — `DurableObjectTicketRepositoryLive`'s
// `ticketColumns` writes Overdue-only fields (`overdue_at`,
// `last_nudged_at`, `nudge_count`) only when `state === "Overdue"`
// and emits `null` / `0` otherwise. The UPSERT then clobbers stale
// values from a prior Overdue row when the ticket transitions away.
// A future refactor that conditionally skips the clobber would
// surface here.
describe("DO projection — Overdue columns clear on state-flip (FP-3)", () => {
  it("Overdue → Cancelled clears overdue_at / last_nudged_at / nudge_count", async () => {
    const id = await issueTicket(validHandle)
    await callNext()
    await backdate(id, { calledAt: longAgo })
    await fireAlarm() // → Overdue (nudgeCount=0)
    await fireAlarm() // → Nudged (nudgeCount=1, lastNudgedAt set)
    // Sanity: Overdue projection has overdue_at populated.
    const overdueRow = await inShopDo(
      (_inst, state) =>
        state.storage.sql
          .exec("SELECT overdue_at, last_nudged_at, nudge_count FROM tickets WHERE id = ?", id)
          .toArray()[0],
    )
    expect(typeof overdueRow?.overdue_at).toBe("string")
    expect(typeof overdueRow?.last_nudged_at).toBe("string")
    expect(Number(overdueRow?.nudge_count ?? -1)).toBe(1)
    // Customer cancels — flips to Cancelled. The projection upsert
    // must clear the Overdue-only columns.
    const cancelRes = await worker().fetch(
      new Request(`http://test/api/v1/tickets/${id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nameKana: validHandle.nameKana,
          phoneLast4: validHandle.phoneLast4,
          reason: "customer-cancelled",
        }),
      }),
    )
    expect(cancelRes.status).toBe(200)
    const cancelledRow = await inShopDo(
      (_inst, state) =>
        state.storage.sql
          .exec(
            "SELECT state, overdue_at, last_nudged_at, nudge_count FROM tickets WHERE id = ?",
            id,
          )
          .toArray()[0],
    )
    expect(cancelledRow?.state).toBe("Cancelled")
    expect(cancelledRow?.overdue_at).toBeNull()
    expect(cancelledRow?.last_nudged_at).toBeNull()
    expect(Number(cancelledRow?.nudge_count ?? -1)).toBe(0)
  })
})

// T3: Nudge atomicity — push failure must not silently advance the
// counter while the customer hears nothing. Implementation contract:
// fanOutPush runs BEFORE the Nudged event is appended, and the
// `channel` field reflects the actual delivery outcome.
describe("QueueShop alarm sweep — Nudge atomicity (ADR-0073 channel = audit truth)", () => {
  // We exercise this by registering a real push_subscriptions row
  // pointing at a fake endpoint that the fanOutPush will hit. The
  // `cloudflareTest` runtime sandboxes outbound fetch through
  // `nock`-like injection: the harness rewrites fetch to return a 410
  // (subscription gone) so we can observe per-outcome behaviour.
  //
  // For Phase-A test scope we assert weaker invariants that don't
  // require monkey-patching `fetch`: a successful WS-only path still
  // produces channel="ws", and the counter advances exactly once.
  // The stronger "all push failed → channel still records what
  // happened" path is exercised via the unit test on `fanOutPush`
  // (added in PR-B); here we lock the call-site shape.

  it("Tick 2 with zero push subscriptions records channel='ws' in the audit log", async () => {
    const id = await issueTicket(validHandle)
    await callNext()
    await backdate(id, { calledAt: longAgo })
    await fireAlarm() // → Overdue
    // No push_subscriptions rows registered → ws path is taken.
    await fireAlarm()
    const events = await inShopDo((_inst, state) =>
      state.storage.sql
        .exec(
          "SELECT payload FROM ticket_events WHERE ticket_id = ? AND type = 'Nudged' ORDER BY seq ASC",
          id,
        )
        .toArray(),
    )
    expect(events.length).toBeGreaterThanOrEqual(1)
    const last = JSON.parse((events[events.length - 1]?.payload as string | undefined) ?? "{}") as {
      readonly channel?: string
    }
    expect(last.channel).toBe("ws")
  })
})

// ADR-0074 — push payload `kind` discriminant. The encrypted push body
// cannot be inspected at the integration boundary (aes128gcm), so the
// kind-derivation is exposed as a pure helper that the integration
// test exercises directly. Production: `fanOutPush` calls this same
// helper before encrypting.
describe("pushKindFor — ADR-0074 nudge payload discriminant", () => {
  it("nextNudgeCount=1 with maxNudges=3 → 'overdue-1'", () => {
    expect(pushKindFor(1, 3)).toBe("overdue-1")
  })

  it("nextNudgeCount=2 with maxNudges=3 → 'overdue-2'", () => {
    expect(pushKindFor(2, 3)).toBe("overdue-2")
  })

  it("nextNudgeCount=3 (= maxNudges) → 'overdue-final' (last warning)", () => {
    expect(pushKindFor(3, 3)).toBe("overdue-final")
  })

  it("nextNudgeCount > maxNudges (defensive) still maps to 'overdue-final'", () => {
    // Shouldn't be reachable via the alarm sweep — Tick 2 only fires
    // when `nudge_count < maxNudges`, so `nextNudgeCount = current + 1`
    // never exceeds `maxNudges` in production. The defensive `>=`
    // branch keeps the helper total.
    expect(pushKindFor(5, 3)).toBe("overdue-final")
  })

  it("maxNudges=1 (degenerate config) sends 'overdue-final' on the first nudge", () => {
    expect(pushKindFor(1, 1)).toBe("overdue-final")
  })
})
