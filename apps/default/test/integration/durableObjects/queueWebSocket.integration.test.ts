import { reset } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  __setWsLifecycleTap,
  type WsLifecycleEvent,
} from "../../../src/server/durableObjects/wsLifecycleLog.js"
import { worker } from "../_harness/httpFixture.js"
import { staffHeaders } from "../_harness/jwtFixture.js"
import * as req from "../_harness/sample-requests.js"
import { openWebSocket } from "../_harness/wsClient.js"

/**
 * Pin the `WsLifecycle` log surface emitted from the QueueShop
 * Durable Object (C8). Asserts every accept / broadcast / close
 * / error event the integration test can drive surfaces through
 * the structured-log tap, and that broadcast carries `sockets`
 * / `ms` / `bytes` so the operator dashboard can chart latency
 * + payload size over time.
 */

const SECRET = "dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef"
const validHandle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }

let events: WsLifecycleEvent[] = []

beforeEach(() => {
  events = []
  __setWsLifecycleTap((event) => {
    events.push(event)
  })
})

afterEach(async () => {
  __setWsLifecycleTap(null)
  await reset()
})

describe("QueueShop WebSocket lifecycle log (C8)", () => {
  it("WS upgrade emits a `ws.accept` event", async () => {
    const ws = await openWebSocket(worker(), "/api/v1/queue/feed")
    expect(events.some((e) => e.type === "accept")).toBe(true)
    ws.close(1000, "test-done")
  })

  it("a state-changing dispatch fans out + emits `ws.broadcast` with sockets / ms / bytes", async () => {
    const ws = await openWebSocket(worker(), "/api/v1/queue/feed")
    // Drain the on-connect projection so the next message is the
    // broadcast we induced.
    await ws.messages.next(2_000)
    await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    const projection = await ws.messages.next(2_000)
    // ADR-0081: the WS envelope shape is `{ v: 6, kind, at,
    // capability, ... }` — there is no `ok` flag (that is the
    // REST `dispatchEnvelope` shape, not the projection feed).
    expect(projection).toMatchObject({ v: 6 })
    const broadcast = events.find((e) => e.type === "broadcast")
    expect(broadcast?.type).toBe("broadcast")
    if (broadcast?.type === "broadcast") {
      expect(broadcast.sockets).toBeGreaterThanOrEqual(1)
      expect(broadcast.bytes).toBeGreaterThan(0)
      expect(broadcast.ms).toBeGreaterThanOrEqual(0)
      expect(broadcast.failed).toBe(0)
    }
    ws.close(1000, "test-done")
  })

  it("client close surfaces `ws.close` with the reported code + reason", async () => {
    const ws = await openWebSocket(worker(), "/api/v1/queue/feed")
    await ws.messages.next(2_000)
    ws.close(1000, "client-done")
    // Give the runtime a tick to fire the close handler. The actual
    // delay depends on Miniflare's scheduler; 250 ms is plenty.
    await new Promise((r) => setTimeout(r, 250))
    const close = events.find((e) => e.type === "close")
    expect(close?.type).toBe("close")
    if (close?.type === "close") {
      expect(close.code).toBe(1000)
      expect(close.reason).toBe("client-done")
    }
  })

  it("two parallel sockets both receive the broadcast (sockets=2 in the log)", async () => {
    const ws1 = await openWebSocket(worker(), "/api/v1/queue/feed")
    const ws2 = await openWebSocket(worker(), "/api/v1/queue/feed")
    await ws1.messages.next(2_000)
    await ws2.messages.next(2_000)
    const auth = await staffHeaders(SECRET)
    await worker().fetch(req.issueTicket({ handle: validHandle, freeText: null }))
    // The broadcaster coalesces dispatches inside `BROADCAST_COALESCE_MS`
    // (default 100 ms — `apps/default/wrangler.toml`). If the two
    // dispatches land in the same window they collapse to a single
    // fan-out, which would starve the second `messages.next` below.
    // Wait past the window so each call produces its own broadcast.
    await new Promise((r) => setTimeout(r, 200))
    await worker().fetch(req.callNext(auth.bearerHeaders))
    // Wait for both broadcasts (Issue, then CallNext) to arrive.
    await ws1.messages.next(2_000)
    await ws1.messages.next(2_000)
    const broadcast = events.findLast((e) => e.type === "broadcast")
    expect(broadcast?.type).toBe("broadcast")
    if (broadcast?.type === "broadcast") {
      expect(broadcast.sockets).toBe(2)
    }
    ws1.close(1000, "done")
    ws2.close(1000, "done")
  })
})
