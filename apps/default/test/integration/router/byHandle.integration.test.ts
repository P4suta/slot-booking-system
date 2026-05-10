import { reset } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { parseJson, worker } from "../_harness/httpFixture.js"
import * as req from "../_harness/sample-requests.js"

/**
 * ADR-0069 — `GET /api/v1/tickets/by-handle?k&p` is the customer's
 * primary recovery path. The handle is the active-set primary key,
 * so a 200 response always carries the unique active ticket; 404
 * means no active ticket holds the handle. RL_VERIFY gates the
 * (kana × last4) enumeration oracle.
 */

const handle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }

afterEach(async () => {
  await reset()
})

describe("GET /api/v1/tickets/by-handle (ADR-0069)", () => {
  it("404 when no active ticket holds the handle", async () => {
    const res = await worker().fetch(req.ticketByHandle(handle))
    expect(res.status).toBe(404)
    const body = await parseJson<{ ok: false; error: { _tag: string } }>(res)
    expect(body.ok).toBe(false)
    expect(body.error._tag).toBe("TicketNotFound")
  })

  it("200 returns the active ticket after a fresh issue", async () => {
    const issue = await worker().fetch(req.issueTicket({ handle, freeText: null }))
    const issued = await parseJson<{ ticket: { id: string; state: string } }>(issue)
    const res = await worker().fetch(req.ticketByHandle(handle))
    expect(res.status).toBe(200)
    const body = await parseJson<{ ok: boolean; ticket: { id: string; state: string } }>(res)
    expect(body.ok).toBe(true)
    expect(body.ticket.id).toBe(issued.ticket.id)
    expect(body.ticket.state).toBe("Waiting")
  })

  it("422 InvalidPayload when nameKana / phoneLast4 are malformed", async () => {
    const res = await worker().fetch(req.ticketByHandle({ nameKana: "abc", phoneLast4: "12" }))
    expect(res.status).toBe(422)
  })

  it("404 again after the ticket reaches a terminal state (handle released)", async () => {
    const issue = await worker().fetch(req.issueTicket({ handle, freeText: null }))
    const issued = await parseJson<{ ticket: { id: string } }>(issue)
    const cancel = await worker().fetch(
      req.cancelTicket(issued.ticket.id, { handle, reason: "test-release" }),
    )
    expect(cancel.status).toBe(200)
    const res = await worker().fetch(req.ticketByHandle(handle))
    expect(res.status).toBe(404)
  })
})
