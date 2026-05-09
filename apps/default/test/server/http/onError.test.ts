import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  __setEnvelopeLogTap,
  type HttpEnvelopeLog,
} from "../../../src/server/http/errorEnvelope.js"
import { onError } from "../../../src/server/http/onError.js"

// Generic JSON parser keeps the response shape pinned at each call
// site without ESLint flagging redundant per-call assertions.
// `Response.json()` is typed `Promise<any>` so the implicit
// assignment to `T` already bridges the types.
const parseJson = async <T>(response: Response): Promise<T> => response.json()

/**
 * `app.onError` is the safety net for any uncaught throw inside a
 * route handler. The tests use a fresh Hono app rather than the
 * full router so the assertion targets `onError` itself, not the
 * production router's middleware chain. The structured log is
 * captured through the test seam in `errorEnvelope.ts`.
 */

let captured: HttpEnvelopeLog[] = []

beforeEach(() => {
  captured = []
  __setEnvelopeLogTap((entry) => {
    captured.push(entry)
  })
})

afterEach(() => {
  __setEnvelopeLogTap(null)
})

const buildAppThatThrows = (msg: string): Hono => {
  const app = new Hono()
  app.onError(onError)
  app.get("/throws", () => {
    throw new Error(msg)
  })
  return app
}

describe("onError handler", () => {
  it("returns 500 + Defect envelope on an uncaught throw", async () => {
    const app = buildAppThatThrows("boom")
    const res = await app.fetch(new Request("http://test/throws"))
    expect(res.status).toBe(500)
    const body = await parseJson<{ ok: boolean; error: { _tag: string; code: string } }>(res)
    expect(body.ok).toBe(false)
    expect(body.error._tag).toBe("Defect")
    expect(body.error.code).toBe("E_DEFECT")
  })

  it("emits HttpEnvelope log with errorTag=Defect, the request method, path, and the underlying message", async () => {
    const app = buildAppThatThrows("descriptive failure")
    await app.fetch(new Request("http://test/throws"))
    expect(captured.length).toBe(1)
    expect(captured[0]?.errorTag).toBe("Defect")
    expect(captured[0]?.errorCode).toBe("E_DEFECT")
    expect(captured[0]?.status).toBe(500)
    expect(captured[0]?.path).toBe("/throws")
    expect(captured[0]?.method).toBe("GET")
    expect(captured[0]?.message).toBe("descriptive failure")
  })

  it("response Content-Type is application/json so the envelope is parseable client-side", async () => {
    const app = buildAppThatThrows("boom")
    const res = await app.fetch(new Request("http://test/throws"))
    expect(res.headers.get("content-type")).toContain("application/json")
  })
})
