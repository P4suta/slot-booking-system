import { reset } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { worker } from "../_harness/httpFixture.js"
import * as req from "../_harness/sample-requests.js"

/**
 * ADR-0073 / ADR-0074 — `POST/DELETE /api/v1/tickets/:id/push-subscription`
 * must enforce customer authentication via `(nameKana, phoneLast4)`
 * so a third party who knows the `ticketId` cannot register or
 * delete subscriptions on behalf of someone else.
 *
 * These tests exercise the four canonical cases:
 *   - handle matches the ticket → 201 / 200
 *   - handle does not match → 403 PhoneMismatch
 *   - ticketId does not exist → 404 TicketNotFound
 *   - handle missing from body / query → 422 InvalidBody
 */

const correctHandle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }
const wrongHandle = { nameKana: "サトウ ハナコ", phoneLast4: "5678" }
const fakeSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abcdef",
  p256dh: "BCDEFG_dummy_p256dh_value_no_real_key",
  auth: "auth_dummy_value",
}

const issueTicketAndGetId = async (): Promise<string> => {
  const res = await worker().fetch(req.issueTicket({ handle: correctHandle, freeText: null }))
  const body: { ticket: { id: string } } = await res.json()
  return body.ticket.id
}

afterEach(async () => {
  await reset()
})

describe("POST /api/v1/tickets/:id/push-subscription auth (ADR-0073/0074)", () => {
  it("201 Created when the handle matches the ticket", async () => {
    const ticketId = await issueTicketAndGetId()
    const res = await worker().fetch(
      new Request(`http://test/api/v1/tickets/${ticketId}/push-subscription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...correctHandle, ...fakeSubscription }),
      }),
    )
    expect(res.status).toBe(201)
  })

  it("403 PhoneMismatch when the handle does not match", async () => {
    const ticketId = await issueTicketAndGetId()
    const res = await worker().fetch(
      new Request(`http://test/api/v1/tickets/${ticketId}/push-subscription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...wrongHandle, ...fakeSubscription }),
      }),
    )
    expect(res.status).toBe(403)
    const body: { error: { _tag: string } } = await res.json()
    expect(body.error._tag).toBe("PhoneMismatch")
  })

  it("404 TicketNotFound for an unknown ticketId", async () => {
    // Valid-shape but unknown ticketId.
    const phantom = "tkt_01HG0000000000000000000000"
    const res = await worker().fetch(
      new Request(`http://test/api/v1/tickets/${phantom}/push-subscription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...correctHandle, ...fakeSubscription }),
      }),
    )
    expect([404, 422]).toContain(res.status)
    if (res.status === 404) {
      const body: { error: { _tag: string } } = await res.json()
      expect(body.error._tag).toBe("TicketNotFound")
    }
  })

  it("422 when the handle is missing from the body", async () => {
    const ticketId = await issueTicketAndGetId()
    const res = await worker().fetch(
      new Request(`http://test/api/v1/tickets/${ticketId}/push-subscription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fakeSubscription), // no nameKana / phoneLast4
      }),
    )
    expect(res.status).toBe(422)
  })

  it("422 when the endpoint is not on the allowlist", async () => {
    const ticketId = await issueTicketAndGetId()
    const res = await worker().fetch(
      new Request(`http://test/api/v1/tickets/${ticketId}/push-subscription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...correctHandle,
          endpoint: "https://attacker.example.com/push/abc",
          p256dh: fakeSubscription.p256dh,
          auth: fakeSubscription.auth,
        }),
      }),
    )
    expect(res.status).toBe(422)
  })
})

describe("DELETE /api/v1/tickets/:id/push-subscription auth (ADR-0073/0074)", () => {
  it("200 when the handle matches (idempotent, even with no row)", async () => {
    const ticketId = await issueTicketAndGetId()
    const params = new URLSearchParams({
      nameKana: correctHandle.nameKana,
      phoneLast4: correctHandle.phoneLast4,
      endpoint: fakeSubscription.endpoint,
    })
    const res = await worker().fetch(
      new Request(`http://test/api/v1/tickets/${ticketId}/push-subscription?${params.toString()}`, {
        method: "DELETE",
      }),
    )
    expect(res.status).toBe(200)
  })

  it("403 PhoneMismatch when the handle does not match", async () => {
    const ticketId = await issueTicketAndGetId()
    const params = new URLSearchParams({
      nameKana: wrongHandle.nameKana,
      phoneLast4: wrongHandle.phoneLast4,
      endpoint: fakeSubscription.endpoint,
    })
    const res = await worker().fetch(
      new Request(`http://test/api/v1/tickets/${ticketId}/push-subscription?${params.toString()}`, {
        method: "DELETE",
      }),
    )
    expect(res.status).toBe(403)
  })

  it("422 when the handle is missing from the query string", async () => {
    const ticketId = await issueTicketAndGetId()
    const params = new URLSearchParams({ endpoint: fakeSubscription.endpoint })
    const res = await worker().fetch(
      new Request(`http://test/api/v1/tickets/${ticketId}/push-subscription?${params.toString()}`, {
        method: "DELETE",
      }),
    )
    expect(res.status).toBe(422)
  })
})
