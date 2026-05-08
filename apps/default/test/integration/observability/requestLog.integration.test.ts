import { reset } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __setRequestLogTap, type HttpRequestLog } from "../../../src/server/http/requestLog.js"
import { TRACE_ID_HEADER } from "../../../src/server/http/traceIdHeader.js"
import { worker } from "../_harness/httpFixture.js"
import { staffHeaders } from "../_harness/jwtFixture.js"
import * as req from "../_harness/sample-requests.js"

/**
 * Pin the `X-Trace-Id` response header + structured `http.request`
 * log emitted by the requestLog middleware (C5).
 *
 * The log assertion uses the test-only seam in
 * `requestLog.ts::__setRequestLogTap` — the worker entry runs in
 * the same isolate as the test (`cloudflareTest`'s `main`), so a
 * module-level callback is enough to capture each entry without
 * scraping stdout. The seam is null in production code paths.
 */

const SECRET = "dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef"
const validHandle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }

let entries: HttpRequestLog[] = []

beforeEach(() => {
  entries = []
  __setRequestLogTap((entry) => {
    entries.push(entry)
  })
})

afterEach(async () => {
  __setRequestLogTap(null)
  await reset()
})

describe("requestLog middleware (X-Trace-Id + http.request log)", () => {
  it("X-Trace-Id is a 26-char Crockford ULID on a 200 response", async () => {
    const res = await worker().fetch(req.queueProjection())
    expect(res.status).toBe(200)
    const trace = res.headers.get(TRACE_ID_HEADER)
    expect(trace).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it("X-Trace-Id is also present on 4xx error responses", async () => {
    const res = await worker().fetch(req.callNext({}))
    expect(res.status).toBe(401)
    expect(res.headers.get(TRACE_ID_HEADER)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it("the structured log entry mirrors the response status + records ms", async () => {
    const res = await worker().fetch(req.queueProjection())
    expect(res.status).toBe(200)
    expect(entries.length).toBeGreaterThanOrEqual(1)
    const lastEntry = entries.at(-1)
    expect(lastEntry).toBeDefined()
    expect(lastEntry?.method).toBe("GET")
    expect(lastEntry?.path).toBe("/api/v1/queue")
    expect(lastEntry?.status).toBe(200)
    expect(lastEntry?.ms).toBeGreaterThanOrEqual(0)
    expect(lastEntry?.traceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it("traceId in the log entry matches the X-Trace-Id header", async () => {
    const res = await worker().fetch(req.openApiDocument())
    expect(res.status).toBe(200)
    expect(entries.length).toBeGreaterThanOrEqual(1)
    const lastEntry = entries.at(-1)
    expect(lastEntry?.traceId).toBe(res.headers.get(TRACE_ID_HEADER))
  })

  it("emits a log entry per request across multiple endpoints", async () => {
    const auth = await staffHeaders(SECRET)
    await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    await worker().fetch(req.queueProjection())
    await worker().fetch(req.callNext(auth.bearerHeaders))
    await worker().fetch(req.markServed("tkt_doesnotexist", auth.bearerHeaders))
    expect(entries.length).toBe(4)
    const paths = entries.map((e) => e.path)
    expect(paths).toContain("/api/v1/tickets")
    expect(paths).toContain("/api/v1/queue")
    expect(paths).toContain("/api/v1/queue/call-next")
    expect(paths).toContain("/api/v1/tickets/tkt_doesnotexist/served")
    for (const e of entries) {
      expect(e.traceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    }
  })

  it("WebSocket 101 upgrade does NOT rewrap the response (no X-Trace-Id, no log truncation)", async () => {
    const res = await worker().fetch(req.queueFeedUpgrade())
    expect(res.status).toBe(101)
    expect(res.headers.get(TRACE_ID_HEADER)).toBeNull()
    expect(entries.length).toBe(1)
    expect(entries[0]?.status).toBe(101)
  })
})
