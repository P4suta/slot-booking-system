import { reset } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { parseJson, worker } from "../_harness/httpFixture.js"
import * as req from "../_harness/sample-requests.js"

/**
 * ADR-0069 idempotent IssueTicket — POST /api/v1/tickets returns
 * 201 Created on the first issue and 200 OK + `merged: true` on
 * subsequent calls with the same handle while the prior ticket is
 * still active. Terminal states release the handle, so a re-issue
 * after Cancel / Served / NoShow starts a fresh 201.
 */

const handle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }

afterEach(async () => {
  await reset()
})

describe("POST /api/v1/tickets — idempotent merge (ADR-0069)", () => {
  it("first issue → 201 Created + merged omitted", async () => {
    const res = await worker().fetch(req.issueTicket({ handle, freeText: null }))
    expect(res.status).toBe(201)
    const body = await parseJson<{ ok: boolean; ticket: { id: string }; merged?: boolean }>(res)
    expect(body.ok).toBe(true)
    expect(body.merged).toBeUndefined()
  })

  it("second issue with the same handle → 200 OK + merged: true + same ticket id", async () => {
    const first = await worker().fetch(req.issueTicket({ handle, freeText: null }))
    expect(first.status).toBe(201)
    const firstBody = await parseJson<{ ticket: { id: string } }>(first)
    const second = await worker().fetch(req.issueTicket({ handle, freeText: null }))
    expect(second.status).toBe(200)
    const secondBody = await parseJson<{ ok: boolean; ticket: { id: string }; merged?: boolean }>(
      second,
    )
    expect(secondBody.ok).toBe(true)
    expect(secondBody.merged).toBe(true)
    expect(secondBody.ticket.id).toBe(firstBody.ticket.id)
  })

  it("after Cancel the handle is released — next issue is 201 again with a fresh id", async () => {
    const first = await worker().fetch(req.issueTicket({ handle, freeText: null }))
    const firstBody = await parseJson<{ ticket: { id: string } }>(first)
    const cancel = await worker().fetch(
      req.cancelTicket(firstBody.ticket.id, { handle, reason: "test" }),
    )
    expect(cancel.status).toBe(200)
    const second = await worker().fetch(req.issueTicket({ handle, freeText: null }))
    expect(second.status).toBe(201)
    const secondBody = await parseJson<{ ticket: { id: string }; merged?: boolean }>(second)
    expect(secondBody.merged).toBeUndefined()
    expect(secondBody.ticket.id).not.toBe(firstBody.ticket.id)
  })
})
