import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BroadcasterCapability } from "../../src/server/durableObjects/Broadcaster.js"
import { WsLifecycle } from "../../src/server/durableObjects/WsLifecycle.js"
import {
  __setWsLifecycleTap,
  type WsLifecycleEvent,
} from "../../src/server/durableObjects/wsLifecycleLog.js"

/**
 * `WebSocketPair` is a Cloudflare Workers global. The node-pool
 * runner has no native binding, so we install a tuple of fake
 * sockets on `globalThis` for the duration of each test. The
 * fakes only need identity — `WsLifecycle.accept` forwards them
 * to deps + the `Response` constructor, neither of which inspect
 * the surface.
 */
type FakeSocket = { readonly __role: "client" | "server" }
type FakePair = readonly [FakeSocket, FakeSocket] & {
  readonly 0: FakeSocket
  readonly 1: FakeSocket
}

// A `function` declaration is constructable; returning a non-`this`
// object from a JS function called with `new` makes the runtime hand
// back that object, mirroring the Cloudflare `WebSocketPair` shape
// (an indexable `{0, 1}` tuple). Arrow functions are *not* `new`-able,
// hence the `function` form rather than the biome-preferred arrow.
function makePairCtor(pair: FakePair): new () => FakePair {
  function WebSocketPairStub(this: unknown): FakePair {
    return pair
  }
  return WebSocketPairStub as unknown as new () => FakePair
}

const installWebSocketPair = (): FakePair => {
  const pair: FakePair = [{ __role: "client" }, { __role: "server" }] as unknown as FakePair
  ;(globalThis as unknown as { WebSocketPair: new () => FakePair }).WebSocketPair =
    makePairCtor(pair)
  return pair
}

const uninstallWebSocketPair = (): void => {
  delete (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair
}

/**
 * Node's `Response` rejects `status: 101` (only 200-599); the Cloudflare
 * runtime allows it as part of the upgrade handshake. We swap in a
 * constructable shim that forwards 200-599 to the original constructor
 * and returns a minimal stand-in for 101 that exposes `status` +
 * `webSocket` (the surface `WsLifecycle.accept` produces and tests
 * inspect). A `function` declaration is `new`-able; arrows are not.
 */
type ResponseShim = { readonly status: number; readonly webSocket: unknown }
function makeResponseShim(original: typeof Response): {
  readonly Patched: typeof Response
  readonly restore: () => void
} {
  function PatchedResponse(
    this: unknown,
    body?: BodyInit | null,
    init?: ResponseInit & { webSocket?: unknown },
  ): Response | ResponseShim {
    if (init?.status === 101) {
      return { status: 101, webSocket: init.webSocket }
    }
    return new original(body, init)
  }
  return {
    Patched: PatchedResponse as unknown as typeof Response,
    restore: () => {
      globalThis.Response = original
    },
  }
}
const installUpgradeFriendlyResponse = (): (() => void) => {
  const { Patched, restore } = makeResponseShim(globalThis.Response)
  globalThis.Response = Patched
  return restore
}

type Deps = {
  readonly acceptWebSocket: ReturnType<
    typeof vi.fn<(ws: WebSocket, tags: readonly string[]) => void>
  >
  readonly setAutoResponse: ReturnType<typeof vi.fn<(req: string, resp: string) => void>>
  readonly connect: ReturnType<
    typeof vi.fn<(ws: WebSocket, capability: BroadcasterCapability) => Promise<void>>
  >
}

const mkDeps = (): Deps => ({
  acceptWebSocket: vi.fn<(ws: WebSocket, tags: readonly string[]) => void>(),
  setAutoResponse: vi.fn<(req: string, resp: string) => void>(),
  connect: vi
    .fn<(ws: WebSocket, capability: BroadcasterCapability) => Promise<void>>()
    .mockResolvedValue(undefined),
})

const upgradeRequest = (url: string): Request =>
  new Request(url, { headers: { upgrade: "websocket" } })

describe("WsLifecycle", () => {
  let events: WsLifecycleEvent[]
  let restoreResponse: () => void

  beforeEach(() => {
    events = []
    __setWsLifecycleTap((event) => {
      events.push(event)
    })
    // The structured log path calls `console.warn` before the tap;
    // silence it so the suite stays quiet without losing observability.
    vi.spyOn(console, "warn").mockImplementation(() => {
      /* silence structured warn logs in the test */
    })
    installWebSocketPair()
    restoreResponse = installUpgradeFriendlyResponse()
  })

  afterEach(() => {
    __setWsLifecycleTap(null)
    vi.restoreAllMocks()
    uninstallWebSocketPair()
    restoreResponse()
  })

  describe("accept", () => {
    it("returns 426 when the `upgrade` header is absent", async () => {
      const deps = mkDeps()
      const lifecycle = new WsLifecycle(deps)

      const response = await lifecycle.accept(new Request("https://shop.test/feed"))

      expect(response.status).toBe(426)
      expect(await response.text()).toBe("Expected websocket upgrade")
      expect(deps.acceptWebSocket).not.toHaveBeenCalled()
      expect(deps.setAutoResponse).not.toHaveBeenCalled()
      expect(deps.connect).not.toHaveBeenCalled()
    })

    it("tags the server socket `cap:staff` and connects as staff for `?capability=staff`", async () => {
      const deps = mkDeps()
      const lifecycle = new WsLifecycle(deps)

      const response = await lifecycle.accept(
        upgradeRequest("https://shop.test/feed?capability=staff"),
      )

      expect(response.status).toBe(101)
      // `Response.webSocket` is the client half of the pair — surfaced
      // back to the runtime so it can complete the upgrade handshake.
      expect((response as unknown as { webSocket: FakeSocket }).webSocket).toEqual({
        __role: "client",
      })
      expect(deps.acceptWebSocket).toHaveBeenCalledTimes(1)
      const [acceptedWs, tags] = deps.acceptWebSocket.mock.calls[0] ?? []
      expect(acceptedWs).toEqual({ __role: "server" })
      expect(tags).toEqual(["cap:staff"])
      expect(deps.setAutoResponse).toHaveBeenCalledWith("ping", "pong")
      expect(deps.connect).toHaveBeenCalledTimes(1)
      const [connectedWs, capability] = deps.connect.mock.calls[0] ?? []
      expect(connectedWs).toEqual({ __role: "server" })
      expect(capability).toBe("staff")
      expect(events).toContainEqual({ type: "accept" })
    })

    it("defaults to `cap:anonymous` when no capability query is present", async () => {
      const deps = mkDeps()
      const lifecycle = new WsLifecycle(deps)

      await lifecycle.accept(upgradeRequest("https://shop.test/feed"))

      const [, tags] = deps.acceptWebSocket.mock.calls[0] ?? []
      expect(tags).toEqual(["cap:anonymous"])
      const [, capability] = deps.connect.mock.calls[0] ?? []
      expect(capability).toBe("anonymous")
    })

    it("falls back to `cap:anonymous` when the capability query is unknown", async () => {
      const deps = mkDeps()
      const lifecycle = new WsLifecycle(deps)

      await lifecycle.accept(upgradeRequest("https://shop.test/feed?capability=foo"))

      const [, tags] = deps.acceptWebSocket.mock.calls[0] ?? []
      expect(tags).toEqual(["cap:anonymous"])
      const [, capability] = deps.connect.mock.calls[0] ?? []
      expect(capability).toBe("anonymous")
    })
  })

  describe("handleMessage", () => {
    it("is a no-op — the projection feed is server-push only", () => {
      const deps = mkDeps()
      const lifecycle = new WsLifecycle(deps)
      const ws = { __role: "server" } as unknown as WebSocket

      expect(() => {
        lifecycle.handleMessage(ws, "anything")
      }).not.toThrow()
      expect(() => {
        lifecycle.handleMessage(ws, new ArrayBuffer(8))
      }).not.toThrow()
      expect(deps.acceptWebSocket).not.toHaveBeenCalled()
      expect(deps.setAutoResponse).not.toHaveBeenCalled()
      expect(deps.connect).not.toHaveBeenCalled()
      expect(events).toEqual([])
    })
  })

  describe("handleClose", () => {
    it("emits a structured `close` event with code / reason / wasClean", () => {
      const deps = mkDeps()
      const lifecycle = new WsLifecycle(deps)
      const ws = { __role: "server" } as unknown as WebSocket

      lifecycle.handleClose(ws, 1000, "client navigated away", true)

      expect(events).toEqual([
        { type: "close", code: 1000, reason: "client navigated away", wasClean: true },
      ])
    })

    it("propagates the abnormal-closure shape (1006 / wasClean=false)", () => {
      const deps = mkDeps()
      const lifecycle = new WsLifecycle(deps)
      const ws = { __role: "server" } as unknown as WebSocket

      lifecycle.handleClose(ws, 1006, "", false)

      expect(events).toEqual([{ type: "close", code: 1006, reason: "", wasClean: false }])
    })
  })

  describe("handleError", () => {
    it("emits `err.message` for `Error` instances", () => {
      const deps = mkDeps()
      const lifecycle = new WsLifecycle(deps)
      const ws = { __role: "server" } as unknown as WebSocket

      lifecycle.handleError(ws, new Error("socket write failed"))

      expect(events).toEqual([{ type: "error", message: "socket write failed" }])
    })

    it("falls back to `String(err)` for non-Error throws", () => {
      const deps = mkDeps()
      const lifecycle = new WsLifecycle(deps)
      const ws = { __role: "server" } as unknown as WebSocket

      lifecycle.handleError(ws, "raw string failure")

      expect(events).toEqual([{ type: "error", message: "raw string failure" }])
    })
  })
})
