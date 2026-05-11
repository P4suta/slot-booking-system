/**
 * WsLifecycle — hibernation-safe WebSocket adapter.
 *
 * The Cloudflare Durable Object hibernating-WebSocket runtime
 * (ADR-0061) delivers four lifecycle hooks to the actor:
 * `fetch` (the upgrade), `webSocketMessage`, `webSocketClose`,
 * `webSocketError`. This class collects the runtime touchpoints
 * so the surrounding facade (QueueShop) can forward each hook in
 * one line. The router-side capability negotiation (ADR-0083 part
 * 2) lands here as the `?capability=staff` query inspection: the
 * lifecycle tags the accepted socket with `cap:staff` or
 * `cap:anonymous`, the Broadcaster reads the tag on every
 * fan-out.
 *
 * The handler is intentionally thin — every concern that *might*
 * grow (resume tokens, bidirectional messages, lifecycle metric
 * exports) lands here, never in the DO facade. The DO does not
 * import `wsLifecycleLog` directly anymore; the adapter does the
 * structured emit.
 */
import { type BroadcasterCapability, CAPABILITY_TAG_PREFIX } from "./Broadcaster.js"
import { logWsAccept, logWsClose, logWsError } from "./wsLifecycleLog.js"

export type WsLifecycleDeps = {
  /** Accept + tag the server-side socket. */
  readonly acceptWebSocket: (ws: WebSocket, tags: readonly string[]) => void
  /** Wire the keepalive ping↔pong so the actor hibernates. */
  readonly setAutoResponse: (req: string, resp: string) => void
  /** Push the initial snapshot through the broadcaster. */
  readonly connect: (ws: WebSocket, capability: BroadcasterCapability) => Promise<void>
}

const readCapability = (url: URL): BroadcasterCapability =>
  url.searchParams.get("capability") === "staff" ? "staff" : "anonymous"

export class WsLifecycle {
  constructor(private readonly deps: WsLifecycleDeps) {}

  /** Handle the `Upgrade: websocket` request. */
  async accept(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 })
    }
    // Capability negotiation: the Hono router verifies the staff JWT
    // before forwarding the upgrade and rewrites the URL with
    // `?capability=staff` when verification succeeds. An absent or
    // unrecognised value defaults to `anonymous` (PII-free).
    const capability = readCapability(new URL(request.url))
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    // Attach the capability tag so per-socket fan-out picks the
    // right frame variant (Broadcaster.fire reads ctx.getTags(ws)).
    this.deps.acceptWebSocket(server, [`${CAPABILITY_TAG_PREFIX}${capability}`])
    // Auto-respond "pong" to client keepalive "ping" frames so the
    // DO stays hibernated for the keepalive traffic. Without this,
    // every 30s ping wakes the actor; with it, the runtime handles
    // the exchange entirely. Idempotent — setting it on every
    // accept just refreshes the same registration.
    this.deps.setAutoResponse("ping", "pong")
    logWsAccept()
    // Send the current projection on connect so the new client has
    // full state immediately rather than waiting for the next mutation.
    await this.deps.connect(server, capability)
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Hibernating-WebSocket message handler. The projection feed is
   * server-push only; client messages are accepted but not
   * processed. Future bidirectional exchanges (e.g. resume-token
   * negotiation) hook in here.
   */
  handleMessage(_ws: WebSocket, _msg: ArrayBuffer | string): void {
    // intentional no-op; the feed is unidirectional today
  }

  /** Lifecycle close hook — structured log only. */
  handleClose(_ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    // No-op on the runtime side: by the time this lifecycle handler
    // fires the socket is already in a closing state, and the
    // Hibernating runtime has already removed it from
    // `ctx.getWebSockets()`. Calling `ws.close(...)` here throws
    // because the socket is no longer mutable from server code.
    // The structured `ws.close` log is the operator's signal that
    // the socket actually disconnected (close code + reason
    // surface "client navigated away" vs "1006 abnormal closure").
    logWsClose(code, reason, wasClean)
  }

  /** Lifecycle error hook — structured log only. */
  handleError(_ws: WebSocket, err: unknown): void {
    // No-op on the runtime side: same lifecycle invariant as
    // `handleClose`. The runtime surfaces the underlying error
    // via the close handshake; we have no recovery path inside the
    // DO that does not race with hibernation. The structured log
    // gives the operator visibility into errored disconnects.
    logWsError(err instanceof Error ? err.message : String(err))
  }
}
