/**
 * Central emit hub for the client-side observability stack
 * (Stage 20 / ADR-0088).
 *
 * The bus is the single fan-out point for `DevEvent`s — every emit
 * site calls `obsBus.emit(...)` and the bus:
 *   1. enriches the event with a severity (default-by-kind or
 *      caller-overridden),
 *   2. pushes the enriched event into the ring (in-memory + session
 *      Storage history),
 *   3. forwards `warning`/`error` severities to the reporter for
 *      batched server escalation,
 *   4. broadcasts to subscribers so a future DevTools panel /
 *      banner UI can react in real time.
 *
 * The default severity table is the policy surface: changing the
 * mapping (`FetchEnd(ok:false)` → warning vs info) is a one-line
 * edit here rather than scattered across emit sites.
 *
 * `window.__obs` is exposed (dev *and* prod by user spec) so an
 * operator inside a customer's browser can paste `__obs.snapshot()`
 * into the console without needing source access to the obs module.
 * The interface is intentionally minimal — `snapshot` (read) and
 * `clear` (purge) — so it cannot be abused to *emit* fake events.
 */

import type { DevEvent, DevEventWithSeverity, Severity } from "./events.js"
import { reportEvent } from "./reporter.js"
import { createRing, type Ring } from "./ringBuffer.js"

/**
 * Default severity per event `kind`. Kept as a table rather than a
 * series of `if` branches so the policy is auditable at a glance.
 * Per-emit overrides at the call site take precedence — callers
 * with extra context (e.g. `WsClose` with `code = 4429`) should
 * pass an explicit severity argument.
 */
const DEFAULT_BY_KIND: Record<DevEvent["kind"], Severity> = {
  FetchStart: "debug",
  FetchEnd: "debug",
  FetchError: "error",
  WsOpen: "info",
  WsFrameIn: "debug",
  WsClose: "info",
  WsError: "error",
  StoreMutation: "debug",
  UncaughtError: "error",
  Lifecycle: "info",
}

/**
 * Context-aware severity adjustment. Applies *after* the default
 * lookup, *before* a caller-specified override. Encodes the
 * heuristics that depend on event fields rather than kind alone.
 */
const adjustForContext = (event: DevEvent, base: Severity): Severity => {
  if (event.kind === "FetchEnd" && !event.ok) return "warning"
  if (event.kind === "WsClose" && event.code >= 4000) return "warning"
  return base
}

const defaultSeverityFor = (event: DevEvent): Severity =>
  adjustForContext(event, DEFAULT_BY_KIND[event.kind])

type Subscriber = (event: DevEventWithSeverity) => void

const subscribers = new Set<Subscriber>()
const ring: Ring<DevEventWithSeverity> = createRing<DevEventWithSeverity>()

const broadcast = (event: DevEventWithSeverity): void => {
  for (const fn of subscribers) {
    try {
      fn(event)
    } catch (err: unknown) {
      // Subscriber errors must not break the fan-out for siblings
      // *and* must not loop back into the bus (which would re-enter
      // emit during emit). Drop to console as last-resort surface.
      console.error("[obs.bus] subscriber threw", err)
    }
  }
}

export const obsBus = {
  emit: (event: DevEvent, severity?: Severity): void => {
    const finalSeverity = severity ?? defaultSeverityFor(event)
    const enriched: DevEventWithSeverity = { ...event, severity: finalSeverity }
    ring.push(enriched)
    reportEvent(enriched)
    broadcast(enriched)
  },
  subscribe: (fn: Subscriber): (() => void) => {
    subscribers.add(fn)
    return () => {
      subscribers.delete(fn)
    }
  },
  snapshot: (): readonly DevEventWithSeverity[] => ring.snapshot(),
  clear: (): void => {
    ring.clear()
  },
} as const

// Console access for live debugging. The interface is read-only
// from the user's POV — `emit` is intentionally not exposed so an
// operator can't pollute the ring from devtools.
type ObsGlobal = {
  snapshot: () => readonly DevEventWithSeverity[]
  clear: () => void
}

const installGlobal = (): void => {
  if (typeof window === "undefined") return
  const target = window as unknown as { __obs?: ObsGlobal }
  target.__obs = {
    snapshot: () => obsBus.snapshot(),
    clear: () => {
      obsBus.clear()
    },
  }
}

installGlobal()

// Wire global error / promise-rejection handlers once at module
// load. We must not double-install in test environments where the
// module may be re-imported across files; the `__obsHandlersInstalled`
// sentinel guards against that.
const wireGlobalHandlers = (): void => {
  if (typeof window === "undefined") return
  const target = window as unknown as { __obsHandlersInstalled?: boolean }
  if (target.__obsHandlersInstalled === true) return
  target.__obsHandlersInstalled = true
  window.addEventListener("error", (ev: ErrorEvent) => {
    obsBus.emit({
      kind: "UncaughtError",
      message: typeof ev.message === "string" ? ev.message : "unknown",
      stack: ev.error instanceof Error ? (ev.error.stack ?? null) : null,
      at: Date.now(),
    })
  })
  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    const reason: unknown = ev.reason
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "unhandled rejection"
    const stack = reason instanceof Error ? (reason.stack ?? null) : null
    obsBus.emit({ kind: "UncaughtError", message, stack, at: Date.now() })
  })
}

wireGlobalHandlers()

/** Test hook: exposed for unit tests to compute the same default a caller would see. */
export const __defaultSeverityFor = defaultSeverityFor
