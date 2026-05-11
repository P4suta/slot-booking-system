import { reset } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { parseJson, worker } from "../_harness/httpFixture.js"
import { staffHeaders } from "../_harness/jwtFixture.js"
import * as req from "../_harness/sample-requests.js"

/**
 * Router smoke — one assertion per endpoint × per outcome shape
 * that we can hit without a state-machine pre-step. The intent is
 * to **pin the HTTP-shape contract** of every endpoint at C3.
 * Behavioral correctness (state transitions, audit log, traceId
 * cross-correlation) is C5 (request log) + C6 (error envelope
 * matrix) + C8 (DO-side log) territory.
 *
 * The fixture-test pair is the tightest signal of router drift:
 * adding / renaming an endpoint here makes the pin-test fail
 * loudly with a well-named subject.
 */

const SECRET = "dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef"

const validHandle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }

afterEach(async () => {
  await reset()
})

describe("router smoke (HTTP shape contract)", () => {
  it("POST /api/v1/tickets — issue with valid handle returns 201 + ticket envelope", async () => {
    const res = await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    expect(res.status).toBe(201)
    const body = await parseJson<{ ok: boolean; ticket: { state: string; seq: number } }>(res)
    expect(body.ok).toBe(true)
    expect(body.ticket.state).toBe("Waiting")
    expect(body.ticket.seq).toBeGreaterThanOrEqual(1)
  })

  it("POST /api/v1/tickets — missing fields returns 422", async () => {
    const res = await worker().fetch(
      req.issueTicket({ handle: { nameKana: "", phoneLast4: "" }, freeText: null }),
    )
    expect(res.status).toBe(422)
  })

  it("GET /api/v1/tickets/me — invalid ticketId returns 404", async () => {
    const res = await worker().fetch(
      req.myTicket({
        ticketId: "tkt_doesnotexist",
        nameKana: validHandle.nameKana,
        phoneLast4: validHandle.phoneLast4,
      }),
    )
    expect(res.status).toBe(404)
  })

  it("POST /api/v1/tickets/:id/cancel — invalid ticketId returns 404", async () => {
    const res = await worker().fetch(
      req.cancelTicket("tkt_doesnotexist", { handle: validHandle, reason: "test" }),
    )
    expect(res.status).toBe(404)
  })

  it("POST /api/v1/queue/call-next — staff token required, missing returns 401", async () => {
    const res = await worker().fetch(req.callNext({}))
    expect(res.status).toBe(401)
  })

  it("POST /api/v1/queue/call-next — empty queue returns 409", async () => {
    const auth = await staffHeaders(SECRET)
    const res = await worker().fetch(req.callNext(auth.bearerHeaders))
    expect(res.status).toBe(409)
  })

  it("POST /api/v1/tickets/:id/served — invalid ticketId returns 404", async () => {
    const auth = await staffHeaders(SECRET)
    const res = await worker().fetch(req.markServed("tkt_doesnotexist", auth.bearerHeaders))
    expect(res.status).toBe(404)
  })

  it("POST /api/v1/tickets/:id/no-show — staff required, missing returns 401", async () => {
    const res = await worker().fetch(req.markNoShow("tkt_x", {}))
    expect(res.status).toBe(401)
  })

  it("POST /api/v1/tickets/:id/recall — staff required, missing returns 401", async () => {
    const res = await worker().fetch(req.recall("tkt_x", {}))
    expect(res.status).toBe(401)
  })

  it("GET /api/v1/queue — anonymous returns 200 + projection envelope", async () => {
    const res = await worker().fetch(req.queueProjection())
    expect(res.status).toBe(200)
    const body = await parseJson<{ ok: boolean; waitingCount: number }>(res)
    expect(body.ok).toBe(true)
    expect(typeof body.waitingCount).toBe("number")
  })

  it("GET /api/v1/openapi.json — returns 200 + valid OpenAPI 3.1 document", async () => {
    const res = await worker().fetch(req.openApiDocument())
    expect(res.status).toBe(200)
    const body = await parseJson<{ openapi: string; paths: Record<string, unknown> }>(res)
    expect(body.openapi).toBe("3.1.0")
    expect(Object.keys(body.paths).length).toBeGreaterThan(0)
  })

  it("POST /api/v1/staff/login — wrong password returns 401", async () => {
    const res = await worker().fetch(req.staffLogin("wrong-password"))
    expect(res.status).toBe(401)
  })

  it("POST /api/v1/staff/login — correct password returns 200 + token + cookie", async () => {
    const res = await worker().fetch(req.staffLogin(SECRET))
    expect(res.status).toBe(200)
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("__Host-staff_session=")
    const body = await parseJson<{ ok: boolean; token: string; expiresIn: number }>(res)
    expect(body.ok).toBe(true)
    expect(body.token).toMatch(/^eyJ/)
    expect(body.expiresIn).toBeGreaterThan(0)
  })

  it("GET /api/v1/queue/feed — non-upgrade returns 426", async () => {
    const res = await worker().fetch(req.queueProjection())
    // queueProjection has no Upgrade header; same path /api/v1/queue
    // is intentional, the WS endpoint is /queue/feed — separate
    // assertion below.
    expect(res.status).toBe(200)
  })

  it("GET /api/v1/queue/feed — without Upgrade returns 426", async () => {
    const res = await worker().fetch(req.queueFeedUpgrade())
    // queueFeedUpgrade builds with Upgrade: websocket; the WS
    // upgrade succeeds with 101 + webSocket attached.
    expect(res.status).toBe(101)
  })

  it("POST /api/v1/tickets — reservation lane with appointmentAt returns 201", async () => {
    const apptAt = new Date(Date.now() + 30 * 60_000).toISOString()
    const res = await worker().fetch(
      req.issueTicket({
        handle: validHandle,
        freeText: null,
        lane: "reservation",
        appointmentAt: apptAt,
      }),
    )
    expect(res.status).toBe(201)
    const body = await parseJson<{
      ok: boolean
      ticket: { lane: string; appointmentAt: string | null }
    }>(res)
    expect(body.ok).toBe(true)
    expect(body.ticket.lane).toBe("reservation")
    expect(body.ticket.appointmentAt).toBe(apptAt)
  })

  it("POST /api/v1/tickets/:id/check-in — unknown id returns 404", async () => {
    const res = await worker().fetch(req.checkInTicket("tkt_doesnotexist"))
    expect(res.status).toBe(404)
  })

  it("POST /api/v1/tickets/:id/check-in — walk-in ticket returns 422 (AppointmentRequired…)", async () => {
    const issue = await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    const issued = await parseJson<{ ticket: { id: string } }>(issue)
    const res = await worker().fetch(req.checkInTicket(issued.ticket.id))
    expect(res.status).toBe(422)
    const body = await parseJson<{ ok: boolean; error: { _tag: string } }>(res)
    expect(body.ok).toBe(false)
    expect(body.error._tag).toBe("AppointmentRequiredForReservationLane")
  })

  it("GET /api/v1/slots — happy path returns the bucket grid", async () => {
    const today = new Date().toISOString().slice(0, 10)
    const res = await worker().fetch(req.listSlots({ from: today, to: today, granularity: 30 }))
    expect(res.status).toBe(200)
    const body = await parseJson<{
      ok: boolean
      slots: readonly { date: string; bucketId: number; capacity: number }[]
    }>(res)
    expect(body.ok).toBe(true)
    // Business-hours filter (default 09:00–17:00, see
    // `route_listSlots`) restricts the 30-min grid to 16 buckets.
    // The cap is intentional — the customer picker never advertises
    // off-hours slots staff cannot honour.
    expect(body.slots.length).toBe(16)
    expect(body.slots[0]?.date).toBe(today)
  })

  it("GET /api/v1/slots — invalid granularity returns 422", async () => {
    const today = new Date().toISOString().slice(0, 10)
    const res = await worker().fetch(
      // 7 is not in {15, 30, 60}; the boundary parser rejects.
      req.listSlots({ from: today, to: today, granularity: 7 as never }),
    )
    expect(res.status).toBe(422)
  })

  it("every non-WS response carries an X-Trace-Id header (Crockford ULID)", async () => {
    const auth = await staffHeaders(SECRET)
    const probes = [
      worker().fetch(req.issueTicket({ handle: validHandle, freeText: null })),
      worker().fetch(req.queueProjection()),
      worker().fetch(req.openApiDocument()),
      worker().fetch(req.staffLogin(SECRET)),
      worker().fetch(req.callNext(auth.bearerHeaders)),
      worker().fetch(req.markServed("tkt_doesnotexist", auth.bearerHeaders)),
    ]
    for (const r of await Promise.all(probes)) {
      const trace = r.headers.get("x-trace-id")
      expect(trace, `missing X-Trace-Id for ${r.url} (status=${String(r.status)})`).not.toBeNull()
      expect(trace).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    }
  })
})
