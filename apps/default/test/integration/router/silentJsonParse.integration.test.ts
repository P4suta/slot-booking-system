import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  __setEnvelopeLogTap,
  type HttpEnvelopeLog,
} from "../../../src/server/http/errorEnvelope.js"
import { parseJson, worker } from "../_harness/httpFixture.js"

/**
 * Pin the silent-JSON-parse fix (C7).
 *
 * Before C7 the three POST endpoints that read a JSON body
 * (`/api/v1/tickets`, `/api/v1/tickets/:id/cancel`,
 * `/api/v1/staff/login`) silently coerced any parse failure to
 * `null` via `.catch(() => null)` and surfaced it as an indistinct
 * 422 `InvalidBody`. After C7 a non-JSON body returns a 400
 * `InvalidPayload` envelope with the underlying parser message in
 * `error.reason`, and the structured log carries a separate tag
 * so the operator can split "client sent garbage bytes" from
 * "client sent JSON that didn't validate".
 */

const buildBadJsonRequest = (path: string): Request =>
  new Request(`http://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ this is not valid json }",
  })

let entries: HttpEnvelopeLog[] = []

beforeEach(() => {
  entries = []
  __setEnvelopeLogTap((entry) => {
    entries.push(entry)
  })
})

afterEach(() => {
  __setEnvelopeLogTap(null)
})

const expectInvalidPayload = async (path: string): Promise<void> => {
  const res = await worker().fetch(buildBadJsonRequest(path))
  expect(res.status, `path=${path}`).toBe(400)
  const body = await parseJson<{
    ok: boolean
    error: { _tag: string; code: string; reason: string }
  }>(res)
  expect(body.ok).toBe(false)
  expect(body.error._tag).toBe("InvalidPayload")
  expect(body.error.code).toBe("E_VAL_PAYLOAD")
  expect(body.error.reason).toBeTypeOf("string")
  expect(body.error.reason.length).toBeGreaterThan(0)
  const last = entries.find((e) => e.path === path && e.status === 400)
  expect(last?.errorTag).toBe("InvalidPayload")
  expect(last?.errorCode).toBe("E_VAL_PAYLOAD")
}

describe("silent JSON parse fix (C7)", () => {
  it("POST /api/v1/tickets — malformed body returns 400 InvalidPayload + log", async () => {
    await expectInvalidPayload("/api/v1/tickets")
  })

  it("POST /api/v1/tickets/:id/cancel — malformed body returns 400 InvalidPayload + log", async () => {
    await expectInvalidPayload("/api/v1/tickets/tkt_doesnotexist/cancel")
  })

  it("POST /api/v1/staff/login — malformed body returns 400 InvalidPayload + log", async () => {
    await expectInvalidPayload("/api/v1/staff/login")
  })

  it("POST with valid JSON but schema-mismatch still returns 422 InvalidBody (distinct from 400)", async () => {
    const res = await worker().fetch(
      new Request("http://example.com/api/v1/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unrelated: "field" }),
      }),
    )
    expect(res.status).toBe(422)
    const body = await parseJson<{ error: { _tag: string } }>(res)
    expect(body.error._tag).toBe("InvalidBody")
  })
})
