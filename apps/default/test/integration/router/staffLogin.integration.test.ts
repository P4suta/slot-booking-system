import { reset } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { buildRequest, parseJson, worker } from "../_harness/httpFixture.js"
import { staffHeaders } from "../_harness/jwtFixture.js"
import * as req from "../_harness/sample-requests.js"

/**
 * Pin the staff login regression surface (S26 / ADR-0095).
 *
 * Covers the full credential lifecycle:
 *
 *   1. `/api/v1/staff/login` — happy path (200 + token + cookie),
 *      wrong password (401), malformed body (422). These are the
 *      three branches the production envelope distinguishes; the
 *      6-reason discriminant lives in the dev-mode `debug` field
 *      (Stage 21 / ADR-0089) and is exercised by the unit tests
 *      that toggle `IS_DEV`.
 *
 *   2. `/api/v1/queue/feed` — the WS upgrade that consumes the
 *      issued credentials. Every credential surface (Bearer JWT,
 *      `__Host-staff_session` cookie, legacy `x-staff-token`
 *      header) must resolve to the staff capability tag; absence
 *      / invalid credentials must default to the anonymous
 *      variant (PII-free) without rejecting the upgrade.
 *
 * Together these guard the entire flow `/staff` mounts on
 * login: POST → cookie set → WS upgrade with cookie → staff
 * frame variant arrives. The regression that triggered the
 * sprint was a missing piece in this chain; pinning it here
 * surfaces a future regression instantly.
 */

const SECRET = "dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef"

const openWebSocketWithHeaders = async (
  headers: Record<string, string>,
): Promise<{ socket: WebSocket; first: Promise<unknown> }> => {
  const request = new Request("http://example.com/api/v1/queue/feed", {
    headers: { Upgrade: "websocket", ...headers },
  })
  const response = await worker().fetch(request)
  if (response.status !== 101 || response.webSocket === null) {
    throw new Error(`WebSocket upgrade expected; got ${String(response.status)}`)
  }
  const socket = response.webSocket
  socket.accept()
  const first = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("No initial WS frame within 2s"))
    }, 2000)
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer)
        try {
          resolve(JSON.parse(event.data as string))
        } catch {
          resolve(event.data)
        }
      },
      { once: true },
    )
  })
  return { socket, first }
}

afterEach(async () => {
  await reset()
})

describe("POST /api/v1/staff/login (S26)", () => {
  it("returns 200 + bearer + cookie on the correct password", async () => {
    const res = await worker().fetch(req.staffLogin(SECRET))
    expect(res.status).toBe(200)
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toMatch(/__Host-staff_session=/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Strict/i)
    expect(setCookie).toMatch(/Path=\//i)
    const body = await parseJson<{ ok: boolean; token: string; expiresIn: number }>(res)
    expect(body.ok).toBe(true)
    expect(body.token.split(".").length).toBe(3)
    expect(body.expiresIn).toBe(8 * 60 * 60)
  })

  it("returns 401 + MissingStaffCapability on wrong password (length mismatch)", async () => {
    const res = await worker().fetch(req.staffLogin("short"))
    expect(res.status).toBe(401)
    const body = await parseJson<{ ok: boolean; error: { _tag: string; code: string } }>(res)
    expect(body.ok).toBe(false)
    expect(body.error._tag).toBe("MissingStaffCapability")
    expect(body.error.code).toBe("E_VAL_MISSING_STAFF_CAPABILITY")
  })

  it("returns 401 + MissingStaffCapability on wrong password (same length)", async () => {
    // Same length as the secret but byte-different — the constant-
    // time compare distinguishes "length right, bytes wrong" from
    // "length wrong" via the dev-mode debug field, but the wire
    // envelope is the same 401.
    const sameLengthBad = "x".repeat(SECRET.length)
    const res = await worker().fetch(req.staffLogin(sameLengthBad))
    expect(res.status).toBe(401)
    const body = await parseJson<{ ok: boolean; error: { _tag: string } }>(res)
    expect(body.error._tag).toBe("MissingStaffCapability")
  })

  it("returns 422 + InvalidBody when the body is missing the password field", async () => {
    const request = buildRequest("/api/v1/staff/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    const res = await worker().fetch(request)
    expect(res.status).toBe(422)
    const body = await parseJson<{ ok: boolean; error: { _tag: string; code: string } }>(res)
    expect(body.error._tag).toBe("InvalidBody")
  })
})

describe("GET /api/v1/queue/feed credential surfaces (S26)", () => {
  it("upgrades anonymously when no credentials are presented", async () => {
    const res = await worker().fetch(req.queueFeedUpgrade())
    expect(res.status).toBe(101)
    expect(res.webSocket).not.toBeNull()
    // accept() before close() — without it the runtime throws on
    // any post-handshake socket method.
    res.webSocket?.accept()
    res.webSocket?.close(1000, "test-done")
  })

  it("upgrades with the staff capability when a valid Bearer JWT is presented", async () => {
    const auth = await staffHeaders(SECRET)
    const { socket, first } = await openWebSocketWithHeaders(auth.bearerHeaders)
    const frame = (await first) as { v: number; capability: string; kind: string }
    expect(frame.v).toBe(6)
    expect(frame.capability).toBe("staff")
    expect(frame.kind).toBe("snapshot")
    socket.close(1000, "test-done")
  })

  it("upgrades with the staff capability when a valid session cookie is presented", async () => {
    const auth = await staffHeaders(SECRET)
    const { socket, first } = await openWebSocketWithHeaders(auth.cookieHeaders)
    const frame = (await first) as { v: number; capability: string }
    expect(frame.capability).toBe("staff")
    socket.close(1000, "test-done")
  })

  it("upgrades with the staff capability when the legacy x-staff-token header is presented", async () => {
    const auth = await staffHeaders(SECRET)
    const { socket, first } = await openWebSocketWithHeaders(auth.tokenHeaders)
    const frame = (await first) as { v: number; capability: string }
    expect(frame.capability).toBe("staff")
    socket.close(1000, "test-done")
  })

  it("falls back to anonymous when the Bearer JWT is invalid (does not reject)", async () => {
    const { socket, first } = await openWebSocketWithHeaders({
      authorization: "Bearer not-a-valid-jwt",
    })
    const frame = (await first) as { v: number; capability: string }
    expect(frame.capability).toBe("anonymous")
    socket.close(1000, "test-done")
  })

  it("falls back to anonymous when the session cookie HMAC is invalid", async () => {
    const { socket, first } = await openWebSocketWithHeaders({
      cookie: "__Host-staff_session=tampered.signature.value",
    })
    const frame = (await first) as { v: number; capability: string }
    expect(frame.capability).toBe("anonymous")
    socket.close(1000, "test-done")
  })
})
