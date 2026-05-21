import { reset } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { worker } from "../_harness/httpFixture.js"
import { inShopDo } from "../_harness/queueShopHarness.js"
import * as req from "../_harness/sample-requests.js"

/**
 * Schema-mediated persistence boundary (ADR-0019 / ADR-0059).
 *
 * `DurableObjectTicketRepositoryLive.load(id)` walks three load
 * strategies in order:
 *
 *   1. **snapshot+delta** — `aggregate_snapshots` row exists for the
 *      id; replay starts from the snapshot baseline and folds the
 *      delta tail in `ticket_events`.
 *   2. **events-only** — no snapshot (the first SNAPSHOT_INTERVAL
 *      events). Replay from `emptySnapshot` over every event row.
 *   3. **legacy projection** — neither a snapshot nor any events.
 *      Falls through to a direct decode of the projection row in
 *      `tickets`. Covers pre-pivot seed data that never landed in
 *      the event log.
 *
 * Each strategy passes its `payload TEXT` through the codec module
 * at `apps/default/src/server/adapters/codec/ticketRowCodec.ts`;
 * the test below pins all three so a future codec or load-strategy
 * change can no longer regress one of them silently.
 */

const validHandle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }

afterEach(async () => {
  await reset()
})

const issueAndExtract = async (): Promise<string> => {
  const res = await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
  expect(res.status).toBe(201)
  const body: { ticket: { id: string } } = await res.json()
  return body.ticket.id
}

const myTicketState = async (ticketId: string): Promise<string> => {
  const res = await worker().fetch(req.myTicket({ ticketId, ...validHandle }))
  expect(res.status).toBe(200)
  const body: { ticket: { state: string } } = await res.json()
  return body.ticket.state
}

describe("DurableObjectTicketRepository.load — codec across all three strategies", () => {
  it("events-only path: fresh Issue replays from the event log alone", async () => {
    const ticketId = await issueAndExtract()

    // Sanity: a single Issue is far below SNAPSHOT_INTERVAL=200, so no
    // snapshot has been emitted yet. The next load() call must hit
    // the events-only branch.
    const snapCount = await inShopDo((_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT COUNT(*) as c FROM aggregate_snapshots WHERE ticket_id = ?", ticketId)
        .toArray()
      return Number(rows[0]?.c ?? 0)
    })
    expect(snapCount).toBe(0)

    expect(await myTicketState(ticketId)).toBe("Waiting")
  })

  it("snapshot+delta path: synthetic snapshot anchors a follow-up cancel", async () => {
    const ticketId = await issueAndExtract()

    // Manually upsert a snapshot at the current revision so a follow-
    // up state-changing call exercises the snapshot+delta replay
    // without first driving 200 events.
    await inShopDo((_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT revision, payload FROM tickets WHERE id = ?", ticketId)
        .toArray()
      const row = rows[0]
      expect(row).not.toBeUndefined()
      state.storage.sql.exec(
        "INSERT INTO aggregate_snapshots (ticket_id, revision, payload) VALUES (?, ?, ?)",
        ticketId,
        Number(row?.revision ?? 0),
        row?.payload,
      )
    })

    // Cancel — the load() the use case runs must hit snapshot+delta.
    // The snapshot is at the post-Issue state; the delta is empty so
    // the inner loop visits zero events but `baseTicket` is still set.
    const cancelRes = await worker().fetch(
      req.cancelTicket(ticketId, { handle: validHandle, reason: "codec characterization" }),
    )
    expect(cancelRes.status).toBe(200)

    expect(await myTicketState(ticketId)).toBe("Cancelled")

    // Confirm the snapshot row is still present (Cancel doesn't reach
    // SNAPSHOT_INTERVAL either, so the row stays at the original
    // revision and is not overwritten in this scenario).
    const snapStill = await inShopDo((_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT revision FROM aggregate_snapshots WHERE ticket_id = ?", ticketId)
        .toArray()
      return Number(rows[0]?.revision ?? -1)
    })
    expect(snapStill).toBeGreaterThanOrEqual(1)
  })

  it("legacy projection path: a tickets row without ticket_events still resolves", async () => {
    const ticketId = await issueAndExtract()

    // Simulate pre-pivot seed: the projection row survives but the
    // event log entries are gone. `load()` must fall through to the
    // tickets-row branch and decode it through the codec.
    await inShopDo((_inst, state) => {
      state.storage.sql.exec("DELETE FROM ticket_events WHERE ticket_id = ?", ticketId)
    })

    expect(await myTicketState(ticketId)).toBe("Waiting")
  })
})
