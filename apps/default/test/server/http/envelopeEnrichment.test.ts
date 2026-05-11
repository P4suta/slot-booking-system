import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { requireStaff } from "../../../src/server/http/_shared.js"
import { handleStaffLogin } from "../../../src/server/http/auth/login.js"
import {
  dispatchDecodeFailure,
  IssueTicketBodySchema,
} from "../../../src/server/http/boundarySchemas.js"
import { type DebugEnvelope, isDevMode } from "../../../src/server/http/errorEnvelope.js"
import { signStaffJwt } from "../../../src/server/security/jwt.js"
import { signSession } from "../../../src/server/security/session.js"

/**
 * Stage 21 / ADR-0089 — server-side error envelope enrichment.
 *
 * The goal of this test file is to pin three properties of the
 * enriched envelope:
 *
 *   1. `IS_DEV === "1"` widens the error envelope with a `debug`
 *      field carrying a {@link DebugEnvelope}. The reason tag is
 *      one of the closed discriminants the helpers emit.
 *   2. Any other `IS_DEV` value (undefined, "0", "false", "true")
 *      completely strips the `debug` field — the wire envelope is
 *      byte-for-byte the same as the pre-Stage-21 shape.
 *   3. Sanitisation invariants: the `receivedHead` / `receivedTail`
 *      preview is capped at four characters, length fields are
 *      integers, and the raw secret never leaks even when dev mode
 *      is on. The 22-class registry mapping and the wire `_tag` /
 *      `code` stay untouched (compat guard).
 *
 * Tests run in the Node environment (vitest project `node`) — no
 * Miniflare boot — so a fake `c.env` is sufficient. The integration
 * suite drives the same envelopes through the worker.
 */

const SECRET = "dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef"
const TTL_SECONDS = 8 * 60 * 60

type GuardCtx = {
  readonly req: { header: (k: string) => string | undefined }
  readonly env: {
    readonly STAFF_SESSION_SECRET?: string
    readonly IS_DEV?: string
  }
}

const makeCtx = (
  headers: Record<string, string>,
  env: { STAFF_SESSION_SECRET?: string; IS_DEV?: string },
): GuardCtx => {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    req: { header: (k: string): string | undefined => lower[k.toLowerCase()] },
    env,
  }
}

type ErrorEnvelope = {
  readonly ok: false
  readonly error: {
    readonly _tag: string
    readonly code: string
    readonly debug?: DebugEnvelope
    readonly reason?: string
  }
}

const parseEnvelope = async (res: Response): Promise<ErrorEnvelope> => await res.json()

// ---------------------------------------------------------------
// isDevMode predicate
// ---------------------------------------------------------------

describe("isDevMode (IS_DEV predicate)", () => {
  it("returns true exactly when IS_DEV === '1'", () => {
    expect(isDevMode({ IS_DEV: "1" })).toBe(true)
  })

  it.each<[string | undefined]>([
    [undefined],
    [""],
    ["0"],
    ["true"],
    ["dev"],
  ])("returns false for IS_DEV=%j", (v) => {
    // Spread to dodge `exactOptionalPropertyTypes` rejection of an
    // explicit `IS_DEV: undefined` literal — the predicate's
    // contract is "missing or non-'1' means non-dev", and the
    // distinct undefined vs absent cases must both fall through.
    const env = v === undefined ? {} : { IS_DEV: v }
    expect(isDevMode(env)).toBe(false)
  })
})

// ---------------------------------------------------------------
// handleStaffLogin — password mismatch debug context
// ---------------------------------------------------------------

const buildLoginRequest = (body: unknown): Request =>
  new Request("http://test/api/v1/staff/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const buildLoginCtx = (req: Request, env: Record<string, string | undefined>): never =>
  ({
    req: { json: () => req.json(), raw: req },
    env,
  }) as never

describe("handleStaffLogin — 401 envelope enrichment (Stage 21)", () => {
  it("dev mode + wrong-length password emits debug.reason=password_length_mismatch with sanitised preview", async () => {
    const req = buildLoginRequest({ password: "abc" })
    const res = await handleStaffLogin(
      buildLoginCtx(req, { STAFF_SESSION_SECRET: SECRET, IS_DEV: "1" }),
    )
    expect(res.status).toBe(401)
    const body = await parseEnvelope(res)
    expect(body.error._tag).toBe("MissingStaffCapability")
    expect(body.error.code).toBe("E_VAL_MISSING_STAFF_CAPABILITY")
    expect(body.error.debug).toBeDefined()
    expect(body.error.debug?.reason).toBe("password_length_mismatch")
    expect(body.error.debug?.receivedLen).toBe(3)
    expect(body.error.debug?.expectedLen).toBe(SECRET.length)
    expect(body.error.debug?.receivedHead).toBe("abc")
    expect(body.error.debug?.receivedTail).toBe("abc")
    expect(body.error.debug?.hint).toMatch(/STAFF_SESSION_SECRET/)
  })

  it("dev mode + same-length wrong-bytes password emits debug.reason=password_value_mismatch", async () => {
    // Construct a password the exact length of SECRET so the
    // length branch is rejected and the value-mismatch branch
    // fires.
    const sameLengthBogus = "X".repeat(SECRET.length)
    const req = buildLoginRequest({ password: sameLengthBogus })
    const res = await handleStaffLogin(
      buildLoginCtx(req, { STAFF_SESSION_SECRET: SECRET, IS_DEV: "1" }),
    )
    expect(res.status).toBe(401)
    const body = await parseEnvelope(res)
    expect(body.error.debug?.reason).toBe("password_value_mismatch")
    expect(body.error.debug?.receivedLen).toBe(SECRET.length)
    expect(body.error.debug?.expectedLen).toBe(SECRET.length)
    // 4-char preview cap — even with a 64-char input, head + tail
    // never exceed 4 chars each. Verifies the redaction invariant.
    expect(body.error.debug?.receivedHead?.length).toBeLessThanOrEqual(4)
    expect(body.error.debug?.receivedTail?.length).toBeLessThanOrEqual(4)
  })

  it("prod mode (IS_DEV undefined) strips debug — wire envelope is { _tag, code } only", async () => {
    const req = buildLoginRequest({ password: "abc" })
    const res = await handleStaffLogin(buildLoginCtx(req, { STAFF_SESSION_SECRET: SECRET }))
    expect(res.status).toBe(401)
    const body = await parseEnvelope(res)
    expect(body.error._tag).toBe("MissingStaffCapability")
    expect(body.error.code).toBe("E_VAL_MISSING_STAFF_CAPABILITY")
    expect(body.error.debug).toBeUndefined()
  })

  it("prod mode IS_DEV='0' also strips debug (only exactly '1' enables dev mode)", async () => {
    const req = buildLoginRequest({ password: "abc" })
    const res = await handleStaffLogin(
      buildLoginCtx(req, { STAFF_SESSION_SECRET: SECRET, IS_DEV: "0" }),
    )
    const body = await parseEnvelope(res)
    expect(body.error.debug).toBeUndefined()
  })

  it("dev mode + secret_missing on the server emits debug.reason=secret_missing 503", async () => {
    const req = buildLoginRequest({ password: "anything" })
    const res = await handleStaffLogin(buildLoginCtx(req, { IS_DEV: "1" }))
    expect(res.status).toBe(503)
    const body = await parseEnvelope(res)
    expect(body.error.debug?.reason).toBe("secret_missing")
    expect(body.error.debug?.hint).toMatch(/STAFF_SESSION_SECRET/)
  })

  it("dev mode + decode failure emits debug.reason=login_body_decode_failure with field=password", async () => {
    const req = buildLoginRequest({ password: 42 })
    const res = await handleStaffLogin(
      buildLoginCtx(req, { STAFF_SESSION_SECRET: SECRET, IS_DEV: "1" }),
    )
    expect(res.status).toBe(422)
    const body = await parseEnvelope(res)
    expect(body.error._tag).toBe("InvalidBody")
    expect(body.error.debug?.reason).toBe("login_body_decode_failure")
    expect(body.error.debug?.field).toBe("password")
  })

  it("debug field never carries the raw secret even when password matches its first 4 chars", async () => {
    // Pasting only the leading 4 chars of the secret is a common
    // dev mistake; the preview field reflects what the operator
    // typed, never the server-side expected secret.
    const partial = SECRET.slice(0, 4)
    const req = buildLoginRequest({ password: partial })
    const res = await handleStaffLogin(
      buildLoginCtx(req, { STAFF_SESSION_SECRET: SECRET, IS_DEV: "1" }),
    )
    const body = await parseEnvelope(res)
    // The preview is the *received* prefix (==partial), not the
    // server-side secret. The body must not contain the secret
    // beyond the 4-char received echo.
    const serialised = JSON.stringify(body)
    expect(serialised).not.toContain(SECRET)
    expect(body.error.debug?.receivedHead).toBe(partial)
  })
})

// ---------------------------------------------------------------
// requireStaff — six failure reasons (golden table)
// ---------------------------------------------------------------

describe("requireStaff — StaffGuardFailureReason golden table (Stage 21)", () => {
  const dev = { IS_DEV: "1" }

  it("secret_missing — STAFF_SESSION_SECRET unset returns 503 + debug.reason=secret_missing", async () => {
    const ctx = makeCtx({}, {})
    const out = await requireStaff(ctx, dev)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe("secret_missing")
    const body = await parseEnvelope(out.res)
    expect(out.res.status).toBe(503)
    expect(body.error.debug?.reason).toBe("secret_missing")
  })

  it("credential_absent — no header / bearer / cookie → 401 + debug.reason=credential_absent", async () => {
    const ctx = makeCtx({}, { STAFF_SESSION_SECRET: SECRET })
    const out = await requireStaff(ctx, dev)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe("credential_absent")
    expect(out.res.status).toBe(401)
    const body = await parseEnvelope(out.res)
    expect(body.error.debug?.reason).toBe("credential_absent")
    expect(body.error.debug?.hint).toMatch(/x-staff-token|Bearer|cookie/)
  })

  it("header_mismatch — x-staff-token present but ≠ secret", async () => {
    const ctx = makeCtx({ "x-staff-token": "bogus" }, { STAFF_SESSION_SECRET: SECRET })
    const out = await requireStaff(ctx, dev)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe("header_mismatch")
    const body = await parseEnvelope(out.res)
    expect(body.error.debug?.reason).toBe("header_mismatch")
  })

  it("bearer_malformed — Authorization present but not `Bearer X`", async () => {
    const ctx = makeCtx({ authorization: "Basic deadbeef" }, { STAFF_SESSION_SECRET: SECRET })
    const out = await requireStaff(ctx, dev)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe("bearer_malformed")
    const body = await parseEnvelope(out.res)
    expect(body.error.debug?.reason).toBe("bearer_malformed")
  })

  it("bearer_malformed — Authorization: Bearer (empty token)", async () => {
    const ctx = makeCtx({ authorization: "Bearer   " }, { STAFF_SESSION_SECRET: SECRET })
    const out = await requireStaff(ctx, dev)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe("bearer_malformed")
  })

  it("bearer_invalid — JWT shape OK but jose verification rejects (wrong secret)", async () => {
    const otherSecret = "a-completely-different-secret-32bytes-hex-deadbeefcafebabe1234567"
    const bearer = await signStaffJwt(otherSecret, TTL_SECONDS)
    const ctx = makeCtx({ authorization: `Bearer ${bearer}` }, { STAFF_SESSION_SECRET: SECRET })
    const out = await requireStaff(ctx, dev)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe("bearer_invalid")
    const body = await parseEnvelope(out.res)
    expect(body.error.debug?.reason).toBe("bearer_invalid")
    expect(body.error.debug?.hint).toMatch(/expired|signature|issuer/i)
  })

  it("cookie_invalid — session cookie HMAC mismatch", async () => {
    // Build a real cookie signed with `SECRET`, then mangle the
    // sig segment so the HMAC check fails at the verifier.
    const goodCookie = await signSession(SECRET, {
      sub: "staff",
      exp: Date.now() + TTL_SECONDS * 1000,
      capabilities: ["operate-queue"],
    })
    const dot = goodCookie.lastIndexOf(".")
    const mangled = `${goodCookie.slice(0, dot)}.aaaaaaaaaaaa`
    const ctx = makeCtx(
      { cookie: `__Host-staff_session=${mangled}` },
      { STAFF_SESSION_SECRET: SECRET },
    )
    const out = await requireStaff(ctx, dev)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe("cookie_invalid")
    const body = await parseEnvelope(out.res)
    expect(body.error.debug?.reason).toBe("cookie_invalid")
  })

  it("ok=true via header — valid x-staff-token short-circuits, no failure envelope", async () => {
    const ctx = makeCtx({ "x-staff-token": SECRET }, { STAFF_SESSION_SECRET: SECRET })
    const out = await requireStaff(ctx, dev)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.via).toBe("header")
  })

  it("ok=true via bearer — valid Bearer JWT reports via=bearer", async () => {
    const bearer = await signStaffJwt(SECRET, TTL_SECONDS)
    const ctx = makeCtx({ authorization: `Bearer ${bearer}` }, { STAFF_SESSION_SECRET: SECRET })
    const out = await requireStaff(ctx, dev)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.via).toBe("bearer")
  })

  it("ok=true via cookie — valid session cookie reports via=cookie", async () => {
    const cookie = await signSession(SECRET, {
      sub: "staff",
      exp: Date.now() + TTL_SECONDS * 1000,
      capabilities: ["operate-queue"],
    })
    const ctx = makeCtx(
      { cookie: `__Host-staff_session=${cookie}` },
      { STAFF_SESSION_SECRET: SECRET },
    )
    const out = await requireStaff(ctx, dev)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.via).toBe("cookie")
  })

  it("prod mode strips debug from the 401 envelope even though `reason` still flows internally", async () => {
    const ctx = makeCtx({}, { STAFF_SESSION_SECRET: SECRET })
    const out = await requireStaff(ctx, {})
    expect(out.ok).toBe(false)
    if (out.ok) return
    // The discriminated `reason` is still available to the
    // caller (server-side audit) — only the wire envelope is
    // redacted. This is the load-bearing redaction invariant.
    expect(out.reason).toBe("credential_absent")
    const body = await parseEnvelope(out.res)
    expect(body.error.debug).toBeUndefined()
  })

  it("requireStaff falls back to c.env when the second arg is omitted", async () => {
    const ctx = makeCtx({}, { STAFF_SESSION_SECRET: SECRET, IS_DEV: "1" })
    // Single-arg call (back-compat shape) still produces dev-mode
    // debug because c.env carries IS_DEV.
    const out = await requireStaff(ctx)
    expect(out.ok).toBe(false)
    if (out.ok) return
    const body = await parseEnvelope(out.res)
    expect(body.error.debug?.reason).toBe("credential_absent")
  })
})

// ---------------------------------------------------------------
// dispatchDecodeFailure — schema field debug
// ---------------------------------------------------------------

describe("dispatchDecodeFailure — debug context (Stage 21)", () => {
  const decode = Schema.decodeUnknownResult(IssueTicketBodySchema)

  const failureIssue = (raw: unknown) => {
    const r = decode(raw)
    if (r._tag !== "Failure") throw new Error("expected decode failure")
    return r.failure
  }

  it("dev mode + bad phoneLast4 emits debug.field=phoneLast4 and the canonical hint", () => {
    const issue = failureIssue({
      nameKana: "ヤマダ タロウ",
      phoneLast4: "abc",
      freeText: null,
    })
    const out = dispatchDecodeFailure(issue, { IS_DEV: "1" })
    expect(out.status).toBe(422)
    expect(out.tag).toBe("InvalidPhoneLast4")
    expect(out.debug).toBeDefined()
    expect(out.debug?.reason).toBe("schema_decode_failure")
    expect(out.debug?.field).toBe("phoneLast4")
    expect(out.debug?.hint).toMatch(/PhoneLast4|\[0-9\]\{4\}/)
  })

  it("dev mode + bad nameKana emits debug.field=nameKana", () => {
    const issue = failureIssue({ nameKana: "abc", phoneLast4: "1234", freeText: null })
    const out = dispatchDecodeFailure(issue, { IS_DEV: "1" })
    expect(out.tag).toBe("InvalidNameKana")
    expect(out.debug?.field).toBe("nameKana")
  })

  it("dev mode + completely-wrong-shape body emits ROOT_FAILURE with InvalidBody + debug without field", () => {
    // `null` (non-object) fails at the top-level Struct and the
    // boundary's `firstFailedFieldKey` returns undefined.
    const issue = failureIssue(null)
    const out = dispatchDecodeFailure(issue, { IS_DEV: "1" })
    expect(out.tag).toBe("InvalidBody")
    expect(out.code).toBe("E_VAL_BODY")
    expect(out.debug).toBeDefined()
    expect(out.debug?.reason).toBe("schema_decode_failure")
    expect(out.debug?.field).toBeUndefined()
    expect(out.debug?.hint).toMatch(/top-level|Schema struct/i)
  })

  it("prod mode strips debug — output is the bare DecodeFailureEnvelope", () => {
    const issue = failureIssue({
      nameKana: "ヤマダ タロウ",
      phoneLast4: "abc",
      freeText: null,
    })
    const out = dispatchDecodeFailure(issue, { IS_DEV: "0" })
    expect(out.tag).toBe("InvalidPhoneLast4")
    expect(out.debug).toBeUndefined()
  })

  it("env defaulted to empty object (no IS_DEV) strips debug", () => {
    const issue = failureIssue({
      nameKana: "ヤマダ タロウ",
      phoneLast4: "abc",
      freeText: null,
    })
    const out = dispatchDecodeFailure(issue)
    expect(out.debug).toBeUndefined()
  })
})
