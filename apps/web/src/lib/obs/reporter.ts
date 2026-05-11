/**
 * Severity-gated batched reporter (Stage 20 / ADR-0088).
 *
 * The reporter is the *escalation* arm of the obs stack: every event
 * lands in the ring (in-memory + sessionStorage) regardless, but
 * only `warning`/`error` severities are forwarded to the server.
 * The Stage 22 server endpoint `/api/v1/__/client-error` will fan
 * the payload into the same audit-log sink as REST `5xx` rows, so
 * the engineering on-call can pivot from a customer's "the page is
 * broken" ticket to the structured-log row via the session id +
 * trace id pair.
 *
 * Coalescing: a 1 s sliding window batches multiple events into a
 * single POST. Most error storms (a flaky reconnect loop, a render
 * exception fired N times per re-render) generate a burst of near-
 * simultaneous events; coalescing keeps the egress predictable
 * even when the page is misbehaving. The timer is `setTimeout`
 * rather than `requestIdleCallback` so the deadline holds even
 * when the tab is backgrounded — browser throttling will make the
 * window > 1 s but the events still flush eventually.
 *
 * Fire-and-forget: the POST's `Promise` is dropped after attaching
 * a `console.error` catch. Re-emitting a `FetchError` on a reporter
 * failure would feed the reporter back into itself (`UncaughtError`
 * → severity error → reporter → fetch fails → `FetchError` → …).
 * That re-entrancy was rejected in the design step in favour of a
 * one-shot console log.
 *
 * Sanitisation: the user-spec requires the reporter stay enabled in
 * production, which makes PII leakage the headline risk. The
 * `sanitise()` step at the payload boundary strips field values that
 * could carry `phoneLast4` / `nameKana` echoes. We do NOT sanitise
 * events at emit time — the in-memory ring is a developer tool only
 * (never shipped over the wire) so it keeps full fidelity.
 *
 * SSR safety: every `window` / `navigator` / `sessionStorage` /
 * `fetch` reference is guarded; on the server side the reporter is
 * a no-op (events still flow through the bus → ring, just nothing
 * leaves the process).
 */

import type { DevEventWithSeverity, Severity } from "./events.js"
import { generateTraceId } from "./traceId.js"

const ENDPOINT = "/api/v1/__/client-error"
const COALESCE_MS = 1000
const SESSION_ID_KEY = "obs.sessionId.v1"

const isReportable = (severity: Severity): boolean => severity === "warning" || severity === "error"

const hasWindow = (): boolean => typeof window !== "undefined"

const readSessionId = (): string => {
  if (!hasWindow()) {
    // SSR / Node path: a fresh per-render id is fine; the reporter
    // wouldn't ship it anyway (no fetch in this branch).
    return generateTraceId()
  }
  try {
    const existing = window.sessionStorage.getItem(SESSION_ID_KEY)
    if (existing !== null && existing.length > 0) return existing
  } catch {
    // privacy-mode storage throw → fall through to a per-render id
    return generateTraceId()
  }
  const fresh = generateTraceId()
  try {
    window.sessionStorage.setItem(SESSION_ID_KEY, fresh)
  } catch {
    // quota / privacy mode: keep the id but skip persistence
  }
  return fresh
}

const memo: { sessionId: string | null } = { sessionId: null }

const sessionId = (): string => {
  memo.sessionId ??= readSessionId()
  return memo.sessionId
}

const userAgent = (): string => {
  if (!hasWindow()) return "ssr"
  try {
    return typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
      ? navigator.userAgent
      : "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * Strip free-text customer-handle fields so the prod reporter never
 * relays `nameKana` / `phoneLast4` / `freeText` (ADR-0064 PII set)
 * even if a future event variant accidentally carries one.
 * Operates on `unknown` defensively because severity-overridden
 * events may have been hand-built with extra fields.
 */
const PII_FIELDS = new Set(["nameKana", "phoneLast4", "freeText"])

const sanitiseValue = (value: unknown): unknown => {
  if (value === null) return value
  if (Array.isArray(value)) return value.map(sanitiseValue)
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = PII_FIELDS.has(k) ? "<redacted>" : sanitiseValue(v)
    }
    return out
  }
  return value
}

const sanitise = (event: DevEventWithSeverity): DevEventWithSeverity =>
  sanitiseValue(event) as DevEventWithSeverity

type Payload = {
  readonly events: readonly DevEventWithSeverity[]
  readonly sessionId: string
  readonly ua: string
}

// Module-scoped buffer + timer. The reporter is intentionally a
// singleton: every emit site shares the same coalesce window, so a
// burst from FetchError + WsError in the same tick fans into one POST.
const state: {
  pending: DevEventWithSeverity[]
  timer: ReturnType<typeof setTimeout> | null
} = {
  pending: [],
  timer: null,
}

const flush = (): void => {
  state.timer = null
  if (state.pending.length === 0) return
  if (!hasWindow() || typeof fetch === "undefined") {
    // SSR branch: drop the batch (it would land in the ring on
    // re-render anyway).
    state.pending = []
    return
  }
  const payload: Payload = {
    events: state.pending.map(sanitise),
    sessionId: sessionId(),
    ua: userAgent(),
  }
  state.pending = []
  // Fire-and-forget. We do NOT re-emit on failure to avoid the
  // reporter feeding itself (see module docstring).
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    // `keepalive` lets the request survive a page unload, which is
    // when a customer is most likely to see a final UncaughtError.
    keepalive: true,
  }).catch((err: unknown) => {
    // Last-resort surface; the reporter cannot self-report without
    // infinite recursion.
    console.error("[obs.reporter] failed to POST batch", err)
  })
}

export const reportEvent = (event: DevEventWithSeverity): void => {
  if (!isReportable(event.severity)) return
  state.pending.push(event)
  state.timer ??= setTimeout(flush, COALESCE_MS)
}

/**
 * Test hook: force-flush the buffer synchronously so a vitest spec
 * can assert on the outgoing payload without sleeping. Not exported
 * from the package barrel; tests import directly.
 */
export const __flushNow = (): void => {
  if (state.timer !== null) {
    clearTimeout(state.timer)
    state.timer = null
  }
  flush()
}

/** Test hook: drop pending events + timer. */
export const __resetReporter = (): void => {
  if (state.timer !== null) {
    clearTimeout(state.timer)
    state.timer = null
  }
  state.pending = []
  memo.sessionId = null
}
