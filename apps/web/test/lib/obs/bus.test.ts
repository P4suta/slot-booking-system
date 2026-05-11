import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __defaultSeverityFor, obsBus } from "../../../src/lib/obs/bus.js"
import type { DevEvent, DevEventWithSeverity } from "../../../src/lib/obs/events.js"
import { __resetReporter } from "../../../src/lib/obs/reporter.js"

/**
 * Stage 20 / ADR-0088 central bus contract.
 *
 * Three behaviours under test:
 *   - severity defaults per kind (incl. context-aware overrides)
 *   - emit pushes into ring + fans out to subscribers
 *   - subscriber throw does not break the fan-out / ring write
 */

// The bus module is imported eagerly which installs `window.__obs`
// + global error handlers; under vitest's `node` environment there
// is no `window`, so the install side-effect is a no-op and we test
// the pure emit / subscribe / ring paths here. The dedicated
// sessionStorage round-trip lives in `ringBuffer.test.ts`.
const fixedAt = 1_715_000_000_000

beforeEach(() => {
  // Ensure the bus has a clean ring + reporter for each spec.
  obsBus.clear()
  __resetReporter()
})

afterEach(() => {
  obsBus.clear()
  __resetReporter()
})

describe("obsBus.emit — default severity by kind", () => {
  it("FetchStart defaults to debug", () => {
    const ev: DevEvent = {
      kind: "FetchStart",
      traceId: "t",
      method: "GET",
      path: "/x",
      at: fixedAt,
    }
    expect(__defaultSeverityFor(ev)).toBe("debug")
  })

  it("FetchError defaults to error", () => {
    const ev: DevEvent = {
      kind: "FetchError",
      traceId: "t",
      method: "GET",
      path: "/x",
      reason: "boom",
      at: fixedAt,
    }
    expect(__defaultSeverityFor(ev)).toBe("error")
  })

  it("WsError defaults to error", () => {
    expect(__defaultSeverityFor({ kind: "WsError", reason: "x", at: fixedAt })).toBe("error")
  })

  it("UncaughtError defaults to error", () => {
    expect(
      __defaultSeverityFor({ kind: "UncaughtError", message: "m", stack: null, at: fixedAt }),
    ).toBe("error")
  })

  it("WsOpen defaults to info", () => {
    expect(__defaultSeverityFor({ kind: "WsOpen", at: fixedAt })).toBe("info")
  })

  it("Lifecycle defaults to info", () => {
    expect(
      __defaultSeverityFor({ kind: "Lifecycle", phase: "mount", route: "/", at: fixedAt }),
    ).toBe("info")
  })

  it("StoreMutation defaults to debug", () => {
    expect(
      __defaultSeverityFor({ kind: "StoreMutation", store: "s", summary: "", at: fixedAt }),
    ).toBe("debug")
  })

  it("WsFrameIn defaults to debug", () => {
    expect(
      __defaultSeverityFor({
        kind: "WsFrameIn",
        capability: "anonymous",
        frameKind: "snapshot",
        bytes: 12,
        triggerTraceId: null,
        at: fixedAt,
      }),
    ).toBe("debug")
  })
})

describe("obsBus.emit — context-aware severity overrides", () => {
  it("FetchEnd with ok=false escalates to warning", () => {
    const ev: DevEvent = {
      kind: "FetchEnd",
      traceId: "t",
      method: "GET",
      path: "/x",
      status: 503,
      ms: 12,
      ok: false,
      at: fixedAt,
    }
    expect(__defaultSeverityFor(ev)).toBe("warning")
  })

  it("FetchEnd with ok=true stays debug", () => {
    const ev: DevEvent = {
      kind: "FetchEnd",
      traceId: "t",
      method: "GET",
      path: "/x",
      status: 200,
      ms: 12,
      ok: true,
      at: fixedAt,
    }
    expect(__defaultSeverityFor(ev)).toBe("debug")
  })

  it("WsClose with code >= 4000 escalates to warning", () => {
    expect(
      __defaultSeverityFor({
        kind: "WsClose",
        code: 4429,
        reason: "rate-limit",
        wasClean: true,
        at: fixedAt,
      }),
    ).toBe("warning")
  })

  it("WsClose with normal code stays info", () => {
    expect(
      __defaultSeverityFor({
        kind: "WsClose",
        code: 1000,
        reason: "ok",
        wasClean: true,
        at: fixedAt,
      }),
    ).toBe("info")
  })
})

describe("obsBus.emit — ring + subscribers fan-out", () => {
  it("pushes the enriched event into the ring", () => {
    obsBus.emit({ kind: "WsOpen", at: fixedAt })
    const snap = obsBus.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]).toEqual({ kind: "WsOpen", at: fixedAt, severity: "info" })
  })

  it("calls each subscriber once per emit", () => {
    const received: DevEventWithSeverity[] = []
    const unsub = obsBus.subscribe((e) => {
      received.push(e)
    })
    obsBus.emit({ kind: "WsOpen", at: fixedAt })
    obsBus.emit({ kind: "WsOpen", at: fixedAt + 1 })
    expect(received).toHaveLength(2)
    unsub()
    obsBus.emit({ kind: "WsOpen", at: fixedAt + 2 })
    expect(received).toHaveLength(2)
  })

  it("respects caller-supplied severity override", () => {
    obsBus.emit({ kind: "WsOpen", at: fixedAt }, "error")
    const snap = obsBus.snapshot()
    expect(snap[0]?.severity).toBe("error")
  })

  it("isolates subscriber throw from sibling subscribers + ring push", () => {
    const received: DevEventWithSeverity[] = []
    obsBus.subscribe(() => {
      throw new Error("boom")
    })
    obsBus.subscribe((e) => {
      received.push(e)
    })
    obsBus.emit({ kind: "WsOpen", at: fixedAt })
    expect(received).toHaveLength(1)
    expect(obsBus.snapshot()).toHaveLength(1)
  })
})

describe("obsBus — installGlobal", () => {
  it("exposes snapshot + clear on window.__obs", () => {
    const target = globalThis as unknown as {
      window?: { __obs?: { snapshot: () => unknown; clear: () => void } }
    }
    // The module-level `installGlobal()` ran at import time; if the
    // test env exposes `window`, __obs should be attached.
    if (typeof globalThis.window === "undefined") return
    expect(target.window?.__obs).toBeDefined()
    expect(typeof target.window?.__obs?.snapshot).toBe("function")
    expect(typeof target.window?.__obs?.clear).toBe("function")
  })
})
