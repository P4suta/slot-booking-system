import { reset } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { worker } from "../_harness/httpFixture.js"
import { inShopDo } from "../_harness/queueShopHarness.js"
import * as req from "../_harness/sample-requests.js"

/**
 * ADR-0069 — the `tickets` table carries a partial UNIQUE index
 * `(name_kana, phone_last4) WHERE state IN ('Waiting','Called')`
 * as the physical safety net behind core's idempotent IssueTicket.
 *
 * Core is the first line of defence: a second issue with the same
 * handle is short-circuited at the use-case level. This file pins
 * the *second* line: the SQLite UNIQUE constraint catches any
 * direct INSERT that bypasses the use case (= a regression or a
 * future ad-hoc fixture path).
 */

const handle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }

afterEach(async () => {
  await reset()
})

describe("ADR-0069 handle UNIQUE index — physical guarantee", () => {
  it("the partial UNIQUE index exists in sqlite_master after ensureDurableObjectSchema", async () => {
    await worker().fetch(req.issueTicket({ handle, freeText: null }))
    const rows = await inShopDo((_inst, state) =>
      state.storage.sql
        .exec(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_tickets_handle_active'",
        )
        .toArray(),
    )
    expect(rows).toHaveLength(1)
    const ddl = rows[0]?.sql as string | undefined
    expect(typeof ddl).toBe("string")
    expect(ddl ?? "").toMatch(/UNIQUE/i)
    expect(ddl ?? "").toMatch(/WHERE state IN \('Waiting', 'Called'\)/i)
  })

  it("a direct INSERT of a colliding active row hits SQLITE_CONSTRAINT", async () => {
    const res = await worker().fetch(req.issueTicket({ handle, freeText: null }))
    expect(res.status).toBe(201)
    await expect(
      inShopDo((_inst, state) =>
        state.storage.sql.exec(
          "INSERT INTO tickets (id, seq, state, name_kana, phone_last4, free_text, issued_at, payload, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          "tkt_collision00000000000000",
          9999,
          "Waiting",
          handle.nameKana,
          handle.phoneLast4,
          null,
          "2026-05-11T00:00:00.000Z",
          "{}",
          1,
        ),
      ),
    ).rejects.toThrow(/UNIQUE|constraint/i)
  })

  it("an INSERT of the same handle in a terminal state succeeds (partial predicate exempt)", async () => {
    const res = await worker().fetch(req.issueTicket({ handle, freeText: null }))
    expect(res.status).toBe(201)
    // Active row exists in `Waiting`. Adding a `Served` row with the
    // same handle is allowed because the WHERE clause excludes it.
    await expect(
      inShopDo((_inst, state) =>
        state.storage.sql.exec(
          "INSERT INTO tickets (id, seq, state, name_kana, phone_last4, free_text, issued_at, payload, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          "tkt_terminal0000000000000000",
          9998,
          "Served",
          handle.nameKana,
          handle.phoneLast4,
          null,
          "2026-05-11T00:00:00.000Z",
          "{}",
          1,
        ),
      ),
    ).resolves.toBeDefined()
  })
})
