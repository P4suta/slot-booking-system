import { describe, expect, it } from "vitest"
import { send } from "../_harness/httpFixture.js"

/**
 * Pin the dev-log-stream route gate (S22b cont. / ADR-0091).
 *
 * Production deploys default to `IS_DEV=0` (`wrangler.toml`), so
 * the route must answer 404 — the surface is undiscoverable to a
 * prod hit, no error envelope leakage, no upgrade response that
 * would hint at a hidden capability. The dev-mode WS upgrade
 * path is exercised manually via `just dev-default` plus a
 * `/dev/inspect` browser session; the workers-pool fixture does
 * not override env vars, so we cannot hit that path here without
 * a parallel wrangler profile.
 */
describe("GET /api/v1/__/dev/log-stream", () => {
  it("returns 404 when IS_DEV !== '1' (production posture)", async () => {
    const res = await send("/api/v1/__/dev/log-stream", { method: "GET" })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("Not Found")
  })

  it("still returns 404 on an attempted upgrade in non-dev mode", async () => {
    const res = await send("/api/v1/__/dev/log-stream", {
      method: "GET",
      upgrade: true,
    })
    expect(res.status).toBe(404)
  })
})
