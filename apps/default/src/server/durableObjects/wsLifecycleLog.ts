/**
 * Hibernating-WebSocket lifecycle log surface for the QueueShop
 * Durable Object (C8).
 *
 * Every lifecycle moment — accept, broadcast, close, error — is
 * surfaced as a structured `WsLifecycle` log entry so the
 * operator dashboard can answer questions like "how many sockets
 * are riding the projection feed right now?", "which close codes
 * dominate?", and "is broadcast latency drifting up?". The shape
 * mirrors `HttpRequest` / `HttpEnvelope` so a single dashboard
 * filter on `_tag` carries through.
 *
 * The module-level tap is the test seam used by the integration
 * tests in `test/integration/durableObjects/`. Production code
 * paths leave it null, so the cost is one null check per emit.
 */

export type WsLifecycleEvent =
  | { readonly type: "accept" }
  | {
      readonly type: "broadcast"
      readonly sockets: number
      readonly ms: number
      readonly bytes: number
      readonly failed: number
    }
  | {
      readonly type: "close"
      readonly code: number
      readonly reason: string
      readonly wasClean: boolean
    }
  | { readonly type: "error"; readonly message: string }

let tap: ((event: WsLifecycleEvent) => void) | null = null
export const __setWsLifecycleTap = (next: ((e: WsLifecycleEvent) => void) | null): void => {
  tap = next
}

const emit = (event: WsLifecycleEvent): void => {
  // `console.warn` is in biome's noConsole allow-list (warn / error
  // are the structured-log levels we use repo-wide); the JSON-line
  // shape mirrors the rest of the structured-log surface.
  console.warn(
    JSON.stringify({
      _tag: "WsLifecycle",
      code: "I_WS_LIFECYCLE",
      severity: "infrastructure",
      ...event,
    }),
  )
  if (tap !== null) tap(event)
}

export const logWsAccept = (): void => {
  emit({ type: "accept" })
}

export const logWsBroadcast = (
  sockets: number,
  ms: number,
  bytes: number,
  failed: number,
): void => {
  emit({ type: "broadcast", sockets, ms, bytes, failed })
}

export const logWsClose = (code: number, reason: string, wasClean: boolean): void => {
  emit({ type: "close", code, reason, wasClean })
}

export const logWsError = (message: string): void => {
  emit({ type: "error", message })
}
