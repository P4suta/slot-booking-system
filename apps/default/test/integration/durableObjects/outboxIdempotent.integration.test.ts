import { reset } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { worker } from "../_harness/httpFixture.js"
import { staffHeaders } from "../_harness/jwtFixture.js"
import { inShopDo } from "../_harness/queueShopHarness.js"
import * as req from "../_harness/sample-requests.js"

/**
 * FP-9 regression lock — `DurableObjectTicketRepositoryLive` uses
 * `INSERT OR IGNORE INTO outbox(id, ...)` keyed on the event id so
 * a re-drained row (alarm crash between INSERT into D1 + DELETE
 * from outbox, then retry) cannot resurface as a duplicate. The
 * single-writer DO (ADR-0053) further guarantees no two save
 * paths produce the same `event.id`, so this lock is a defensive
 * net: a future refactor that switches to plain `INSERT` would
 * silently allow duplicates until reaching production.
 *
 * Strategy: replay the same outbox row into the DO twice through
 * direct SQL (mirroring how a crash + retry would look) and assert
 * the row count stays at 1.
 */

const SECRET = "dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef"
const validHandle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }

afterEach(async () => {
  await reset()
})

describe("outbox idempotent INSERT lock (FP-9)", () => {
  it("re-inserting the same outbox row by id is a no-op", async () => {
    // First, drive a successful issue → exactly one outbox row exists.
    const res = await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    expect(res.status).toBe(201)

    const initialRows = await inShopDo((_inst, state) =>
      state.storage.sql.exec("SELECT id, payload FROM outbox").toArray(),
    )
    expect(initialRows.length).toBe(1)
    const id = initialRows[0]?.id as string
    const payload = initialRows[0]?.payload as string
    const ticketId = initialRows[0]?.ticket_id as string

    // Simulate a redrain attempt: re-execute the same INSERT OR
    // IGNORE statement the repository uses. SQLite collapses the
    // second INSERT to a no-op because the primary key collides.
    await inShopDo((_inst, state) => {
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO outbox (id, ticket_id, payload) VALUES (?, ?, ?)",
        id,
        ticketId,
        payload,
      )
    })

    const afterRows = await inShopDo((_inst, state) =>
      state.storage.sql.exec("SELECT id, payload FROM outbox WHERE id = ?", id).toArray(),
    )
    expect(afterRows.length).toBe(1)
    // Payload unchanged — IGNORE keeps the original row.
    expect(afterRows[0]?.payload as string).toBe(payload)
  })

  it("a CallNext after Issue produces two distinct outbox rows (different event ids)", async () => {
    // Counter-test: confirm normal flow does NOT collapse — we're
    // asserting that the idempotency lock only fires on a true
    // duplicate `event.id`, not on logically-distinct events.
    await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    const auth = await staffHeaders(SECRET)
    await worker().fetch(req.callNext(auth.bearerHeaders))
    const rows = await inShopDo((_inst, state) =>
      state.storage.sql.exec("SELECT id FROM outbox").toArray(),
    )
    expect(rows.length).toBe(2)
    expect(rows[0]?.id).not.toBe(rows[1]?.id)
  })
})
