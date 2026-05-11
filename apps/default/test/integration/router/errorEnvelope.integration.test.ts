import { reset } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  __setEnvelopeLogTap,
  type HttpEnvelopeLog,
} from "../../../src/server/http/errorEnvelope.js"
import { parseJson, worker } from "../_harness/httpFixture.js"
import { staffHeaders } from "../_harness/jwtFixture.js"
import * as req from "../_harness/sample-requests.js"

/**
 * Drive the realistic HTTP-reachable error tags + assert the
 * `HttpEnvelope` log shape emitted by the `envelopeLog`
 * middleware (C6). Tags that the API surface cannot induce
 * naturally (`Concurrency`, `Storage`, `AggregateNotFound`,
 * `InsufficientCapability`) are pinned at the unit level in
 * `test/server/http/errorEnvelope.test.ts`'s registry matrix.
 */

const SECRET = "dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef"
const validHandle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }

let entries: HttpEnvelopeLog[] = []

beforeEach(() => {
  entries = []
  __setEnvelopeLogTap((entry) => {
    entries.push(entry)
  })
})

afterEach(async () => {
  __setEnvelopeLogTap(null)
  await reset()
})

const lastErrorEntry = (status?: number): HttpEnvelopeLog | undefined => {
  if (status === undefined) return entries.at(-1)
  return [...entries].reverse().find((e) => e.status === status)
}

describe("envelopeLog middleware (HttpEnvelope log)", () => {
  it("MissingStaffCapability 401 — staff endpoint hit without a credential", async () => {
    const res = await worker().fetch(req.callNext({}))
    expect(res.status).toBe(401)
    const last = lastErrorEntry(401)
    expect(last?.errorTag).toBe("MissingStaffCapability")
    expect(last?.path).toBe("/api/v1/queue/call-next")
    expect(last?.method).toBe("POST")
    expect(last?.traceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it("QueueEmpty 409 — call-next on an empty queue", async () => {
    const auth = await staffHeaders(SECRET)
    const res = await worker().fetch(req.callNext(auth.bearerHeaders))
    expect(res.status).toBe(409)
    const last = lastErrorEntry(409)
    expect(last?.errorTag).toBe("QueueEmpty")
    expect(last?.errorCode).toBe("E_DOM_QUEUE_EMPTY")
  })

  it("TicketNotFound 404 — staff acts on a non-existent ticketId", async () => {
    const auth = await staffHeaders(SECRET)
    const res = await worker().fetch(req.markServed("tkt_doesnotexist", auth.bearerHeaders))
    expect(res.status).toBe(404)
    const last = lastErrorEntry(404)
    expect(last?.errorTag).toBe("TicketNotFound")
  })

  it("InvalidBody 422 — issueTicket with malformed payload", async () => {
    const res = await worker().fetch(
      req.issueTicket({ handle: { nameKana: "", phoneLast4: "" }, freeText: null }),
    )
    expect(res.status).toBe(422)
    const last = lastErrorEntry(422)
    // The router emits `InvalidBody` when the top-level Schema
    // parse fails; deeper validation surfaces the registry's
    // own `Invalid*` tag. Either is acceptable evidence the
    // envelope log saw a 422.
    expect(["InvalidBody", "InvalidNameKana", "InvalidPhoneLast4"]).toContain(last?.errorTag)
    expect(last?.path).toBe("/api/v1/tickets")
  })

  it("PhoneMismatch 403 — myTicket lookup with the wrong handle", async () => {
    const issue = await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    const issueBody = await parseJson<{ ticket: { id: string } }>(issue)
    const res = await worker().fetch(
      req.myTicket({
        ticketId: issueBody.ticket.id,
        nameKana: "サトウ ハナコ",
        phoneLast4: "9999",
      }),
    )
    expect(res.status).toBe(403)
    const last = lastErrorEntry(403)
    expect(last?.errorTag).toBe("PhoneMismatch")
  })

  it("InvalidEntityId 404 — myTicket with a non-prefixed ticketId", async () => {
    const res = await worker().fetch(
      req.myTicket({
        ticketId: "not-a-real-ticket-id",
        nameKana: validHandle.nameKana,
        phoneLast4: validHandle.phoneLast4,
      }),
    )
    expect(res.status).toBe(404)
    const last = lastErrorEntry(404)
    // The router routes invalid ticketIds through `TicketNotFound`
    // for response uniformity (avoid leaking parse-vs-storage
    // distinction); the envelope helper logs that tag verbatim.
    expect(last?.errorTag).toBe("TicketNotFound")
  })

  it("AlreadyCalled-or-empty 409 — calling next twice with one ticket in queue", async () => {
    const auth = await staffHeaders(SECRET)
    await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    await worker().fetch(req.callNext(auth.bearerHeaders))
    const res = await worker().fetch(req.callNext(auth.bearerHeaders))
    expect(res.status).toBe(409)
    const last = lastErrorEntry(409)
    // After one Issue + one CallNext, a second CallNext finds an
    // already-Called ticket and the empty Waiting queue; the
    // domain layer surfaces this as `QueueEmpty`.
    expect(last?.errorTag).toBe("QueueEmpty")
  })

  it("successful 2xx responses do NOT emit envelope log entries", async () => {
    const res = await worker().fetch(req.queueProjection())
    expect(res.status).toBe(200)
    expect(entries.find((e) => e.path === "/api/v1/queue")).toBeUndefined()
  })

  it("InvalidPhoneLast4 422 — body with non-4-digit phoneLast4", async () => {
    const res = await worker().fetch(
      req.issueTicket({
        handle: { nameKana: validHandle.nameKana, phoneLast4: "abc" },
        freeText: null,
      }),
    )
    expect(res.status).toBe(422)
    const last = lastErrorEntry(422)
    expect(last?.errorTag).toBe("InvalidPhoneLast4")
  })

  it("InvalidNameKana 422 — body with non-katakana nameKana", async () => {
    const res = await worker().fetch(
      req.issueTicket({
        handle: { nameKana: "abcdef", phoneLast4: "1234" },
        freeText: null,
      }),
    )
    expect(res.status).toBe(422)
    const last = lastErrorEntry(422)
    expect(last?.errorTag).toBe("InvalidNameKana")
  })

  it("InvalidFreeText 422 — cancel body with too-long freeText (reason)", async () => {
    // The cancel body's `reason` is decoded through the
    // FreeText brand which caps at 200 chars; the boundary
    // emits InvalidFreeText with the offending field.
    const oversize = "あ".repeat(201)
    const issue = await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    const issueBody = await parseJson<{ ticket: { id: string } }>(issue)
    const res = await worker().fetch(
      req.cancelTicket(issueBody.ticket.id, { handle: validHandle, reason: oversize }),
    )
    expect(res.status).toBe(422)
    const last = lastErrorEntry(422)
    // The deep validator runs *after* the body schema accepts the
    // shape; if it surfaces InvalidFreeText we record it. Otherwise
    // the simpler InvalidBody envelope is the boundary's signal.
    expect(["InvalidFreeText", "InvalidBody"]).toContain(last?.errorTag)
  })

  it("InvalidStateTransition 409 — mark-served on a Waiting ticket", async () => {
    const auth = await staffHeaders(SECRET)
    const issue = await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    const issueBody = await parseJson<{ ticket: { id: string } }>(issue)
    // The ticket is Waiting (no CallNext yet); mark-served must
    // surface InvalidStateTransition rather than silently no-op.
    const res = await worker().fetch(req.markServed(issueBody.ticket.id, auth.bearerHeaders))
    expect(res.status).toBe(409)
    const last = lastErrorEntry(409)
    expect(last?.errorTag).toBe("InvalidStateTransition")
  })

  it("AlreadyCancelled 409 — cancel a cancelled ticket via the customer flow", async () => {
    const issue = await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    const issueBody = await parseJson<{ ticket: { id: string } }>(issue)
    await worker().fetch(
      req.cancelTicket(issueBody.ticket.id, { handle: validHandle, reason: "first" }),
    )
    const res = await worker().fetch(
      req.cancelTicket(issueBody.ticket.id, { handle: validHandle, reason: "second" }),
    )
    expect(res.status).toBe(409)
    const last = lastErrorEntry(409)
    expect(last?.errorTag).toBe("AlreadyCancelled")
  })

  it("AlreadyCompleted 409 — mark-served a Served ticket", async () => {
    const auth = await staffHeaders(SECRET)
    const issue = await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    const issueBody = await parseJson<{ ticket: { id: string } }>(issue)
    await worker().fetch(req.callNext(auth.bearerHeaders))
    await worker().fetch(req.markServed(issueBody.ticket.id, auth.bearerHeaders))
    // Second served-mark on the now-Served ticket surfaces
    // AlreadyCompleted.
    const res = await worker().fetch(req.markServed(issueBody.ticket.id, auth.bearerHeaders))
    expect(res.status).toBe(409)
    const last = lastErrorEntry(409)
    expect(last?.errorTag).toBe("AlreadyCompleted")
  })

  it("InvalidStateTransition 409 — no-show a PendingNoShow ticket", async () => {
    // Post-ADR-0074: `/no-show` dispatches `MarkPendingNoShow`
    // (Called → PendingNoShow); the *alarm sweep* later
    // transitions PendingNoShow → NoShow once the grace window
    // elapses. A second `/no-show` against a ticket that is still
    // in the PendingNoShow grace state hits the from-state guard
    // and surfaces `InvalidStateTransition`, not `AlreadyNoShow`.
    // (The `AlreadyNoShow` envelope is reachable only when the
    // alarm has fired into terminal NoShow — exercised by
    // domain-layer unit tests rather than the integration runner.)
    const auth = await staffHeaders(SECRET)
    const issue = await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    const issueBody = await parseJson<{ ticket: { id: string } }>(issue)
    await worker().fetch(req.callNext(auth.bearerHeaders))
    await worker().fetch(req.markNoShow(issueBody.ticket.id, auth.bearerHeaders))
    const res = await worker().fetch(req.markNoShow(issueBody.ticket.id, auth.bearerHeaders))
    expect(res.status).toBe(409)
    const last = lastErrorEntry(409)
    expect(last?.errorTag).toBe("InvalidStateTransition")
  })
})
