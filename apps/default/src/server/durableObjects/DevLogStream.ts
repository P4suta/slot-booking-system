/**
 * DevLogStream — dev-only Durable Object that relays
 * structured-log lines emitted by the worker to any client
 * subscribed over WebSocket.
 *
 * Stage 22b cont. / ADR-0091.
 *
 * Why a separate DO (rather than folding into QueueShop): the
 * hub-spoke split (ADR-0083) exists to bound the queue actor's
 * blast radius. A dev-only fan-out has unrelated WS lifecycle,
 * its own hibernation contract, and zero overlap with queue
 * state; carrying it inside QueueShop would mix audiences and
 * concerns. A separate DO costs one binding + one migration row
 * — both reversible — and the class sleeps when `IS_DEV=0` so
 * production pays nothing.
 *
 * Why in-memory only (no SQLite): the log stream is best-effort
 * live observability, not an audit log. A hibernation wake
 * legitimately starts with an empty ring — the operator sees
 * the next entries the moment they flow, not a backfilled
 * history from cold storage. The size-256 ring is large enough
 * to keep the `/dev/inspect` Stream pane populated during the
 * burst that immediately follows reconnect, small enough not to
 * pressure the actor's heap during long-lived sessions.
 *
 * Trust model: the route in `routes.ts` gates the WS upgrade on
 * `IS_DEV === "1"` (404 in prod). The DO itself does no auth;
 * if you cross the gate you see every structured-log line the
 * worker emits during your session. PII discipline is enforced
 * upstream — the structured-log lines have already passed
 * through `WorkersLoggerLive` / `clientReport`'s sanitisation
 * before they reach `publishLog`.
 */
import { DurableObject } from "cloudflare:workers"

/**
 * A single relayed structured-log entry. `line` is the
 * already-serialised JSON the corresponding `console.{x}` call
 * also wrote — keeping the wire shape identical to the worker's
 * native log sink lets the `/dev/inspect` Stream pane render
 * the same JSON the operator dashboard would show, without a
 * second encoder.
 */
export type DevLogEntry = {
  readonly level: "info" | "warn" | "error"
  readonly emittedAt: number
  readonly line: string
}

/**
 * Ring buffer capacity. The number is balanced against the
 * worker's typical structured-log emission rate (one HttpRequest
 * + one HttpEnvelope per failing request + ad-hoc ClientReport
 * entries): 256 keeps ~5 minutes of moderate-traffic history
 * for a freshly-reconnecting `/dev/inspect` session without
 * inflating the DO's heap budget.
 */
const RING_CAPACITY = 256

/**
 * DO `Env` shape — the dev log stream takes no upstream
 * bindings or vars; it is a pure relay surface.
 */
type Env = Record<string, never>

export class DevLogStream extends DurableObject<Env> {
  /**
   * In-memory ring of recent entries. Backfilled to every new
   * subscriber on `fetch` so a reconnect inside the same actor
   * session does not lose the burst that fired during the
   * round-trip.
   */
  private ring: DevLogEntry[] = []

  /**
   * Append a new structured-log entry to the ring and fan it
   * out to every attached subscriber. Called from the worker's
   * `__setDevLogPublisher` hook on every `console.{x}` emit.
   *
   * Fire-and-forget — the caller does `void stub.publishLog(...)`
   * so a slow socket cannot back-pressure the worker's request
   * path. Send failures are swallowed; the runtime reaps closed
   * sockets on the next `webSocketClose` cycle.
   */
  publishLog(entry: DevLogEntry): Promise<void> {
    if (this.ring.length >= RING_CAPACITY) this.ring.shift()
    this.ring.push(entry)
    const payload = JSON.stringify(entry)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload)
      } catch {
        // socket closing / closed — runtime cleans up; the next
        // publishLog call sees the reduced getWebSockets() set
      }
    }
    return Promise.resolve()
  }

  /**
   * Handle the WS upgrade. The router pre-gates on `IS_DEV` so
   * a stray prod hit cannot reach this method, but the upgrade
   * sanity check is kept as a defence-in-depth guard.
   *
   * Backfill: the new socket receives the current ring contents
   * before any live broadcast, so a `/dev/inspect` page mount
   * never opens with an empty Stream pane when the worker has
   * been busy.
   */
  override fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return Promise.resolve(new Response("Expected websocket upgrade", { status: 426 }))
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    // Keep the actor hibernated through client keepalive pings —
    // same idiom as QueueShop's queue feed.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))
    for (const entry of this.ring) {
      try {
        server.send(JSON.stringify(entry))
      } catch {
        // The socket is fresh; a send failure here is exceptional
        // and almost always means the peer disconnected before the
        // handshake completed. Drop the rest of the backfill —
        // there is no consumer.
        break
      }
    }
    return Promise.resolve(new Response(null, { status: 101, webSocket: client }))
  }

  /**
   * Hibernating-WebSocket message handler. The stream is
   * server-push only; client messages are accepted (so the keepalive
   * `ping` auto-response stays cheap) but not interpreted.
   */
  override webSocketMessage(_ws: WebSocket, _msg: ArrayBuffer | string): void {
    // intentional no-op; the relay is unidirectional
  }

  /**
   * On close, the runtime has already removed the socket from
   * `ctx.getWebSockets()` — no extra bookkeeping needed.
   */
  override webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    // runtime reaps the socket; nothing to clean up here
  }

  /**
   * Same lifecycle invariant as `webSocketClose`. Errors surface
   * to the operator via the worker's own structured-log channel
   * — the dev relay does not duplicate them.
   */
  override webSocketError(_ws: WebSocket, _err: unknown): void {
    // runtime reaps the socket; the upstream log already records the error
  }
}
