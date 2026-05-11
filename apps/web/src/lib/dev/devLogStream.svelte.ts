/**
 * Dev-only WS subscriber for `/api/v1/__/dev/log-stream`
 * (Stage 23 / ADR-0092).
 *
 * The page-level `/dev/inspect` panel calls `startDevLogStream`
 * on mount and the returned dispose function on unmount. The
 * subscriber maintains a small in-memory ring (`MAX_ENTRIES`) of
 * the most recent structured-log lines so reconnects do not
 * lose history mid-session.
 *
 * Mirrors the wire shape produced by the server-side
 * `DevLogStream` DO (ADR-0091). Each entry's `line` field is the
 * already-JSON-encoded payload the worker also wrote to
 * `console.{level}` — the inspector renders it as-is so the
 * dev surface and the operator dashboard converge on one byte
 * stream.
 *
 * Status field: `connecting` → `open` (on first server hello) →
 * `closed` (on disconnect). The inspector uses this for the
 * status pill; no automatic reconnect — dev surfaces stay
 * silent on transient failures so the developer notices when
 * something is wrong with their dev tunnel.
 */

export type DevLogEntry = {
  readonly level: "info" | "warn" | "error"
  readonly emittedAt: number
  readonly line: string
}

export type DevLogStreamStatus = "connecting" | "open" | "closed"

const MAX_ENTRIES = 256

export const devLogStream = $state<{
  entries: readonly DevLogEntry[]
  status: DevLogStreamStatus
}>({ entries: [], status: "closed" })

const isDevLogEntry = (value: unknown): value is DevLogEntry => {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.level === "info" || v.level === "warn" || v.level === "error") &&
    typeof v.emittedAt === "number" &&
    typeof v.line === "string"
  )
}

/**
 * Open a WebSocket against `/api/v1/__/dev/log-stream`. Returns
 * a dispose function the caller invokes on unmount. SSR-safe —
 * no-op when `window` is unavailable.
 */
export const startDevLogStream = (): (() => void) => {
  if (typeof window === "undefined") {
    return () => {
      // SSR no-op
    }
  }
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:"
  const url = `${scheme}//${window.location.host}/api/v1/__/dev/log-stream`
  devLogStream.status = "connecting"
  devLogStream.entries = []
  const ws = new WebSocket(url)
  ws.onopen = () => {
    devLogStream.status = "open"
  }
  ws.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return
    try {
      const parsed: unknown = JSON.parse(event.data)
      if (!isDevLogEntry(parsed)) return
      const next = [...devLogStream.entries, parsed]
      if (next.length > MAX_ENTRIES) next.shift()
      devLogStream.entries = next
    } catch {
      // malformed payload — drop silently, the inspector is best-effort
    }
  }
  ws.onclose = () => {
    devLogStream.status = "closed"
  }
  ws.onerror = () => {
    devLogStream.status = "closed"
  }
  return () => {
    try {
      ws.close(1000, "inspector-unmount")
    } catch {
      // already closed
    }
  }
}
