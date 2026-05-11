import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DevEventWithSeverity } from "../../../src/lib/obs/events.js"
import { __flushNow, __resetReporter, reportEvent } from "../../../src/lib/obs/reporter.js"

/**
 * Stage 20 / ADR-0088 reporter contract.
 *
 * The reporter is the *escalation* arm of the obs stack:
 *   - debug / info severities never leave the process
 *   - warning / error severities accumulate in a 1 s coalesce window
 *     and ship as one POST to /api/v1/__/client-error
 *   - fire-and-forget: a fetch reject only console.errors
 *   - sanitisation strips PII fields (nameKana / phoneLast4 / freeText)
 */

type FetchMock = ReturnType<typeof vi.fn>

type StorageOverrides = Partial<Pick<Storage, "getItem" | "setItem" | "removeItem">>

const makeStorageWith = (overrides: StorageOverrides): Storage => {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => {
      store.clear()
    },
    getItem: overrides.getItem ?? ((k: string) => store.get(k) ?? null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem:
      overrides.removeItem ??
      ((k: string) => {
        store.delete(k)
      }),
    setItem:
      overrides.setItem ??
      ((k: string, v: string) => {
        store.set(k, v)
      }),
  }
}

const makeStorage = (): Storage => makeStorageWith({})

const installWindow = (storage: Storage): void => {
  ;(globalThis as unknown as { window: { sessionStorage: Storage } }).window = {
    sessionStorage: storage,
  }
  // `navigator` on Node ≥ 21 is a non-configurable getter. Define
  // (or redefine) via Object.defineProperty so the assignment works
  // in both Node 22 (vitest under test) and a Node 18 fallback
  // where `globalThis.navigator` is plain-writable.
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "vitest-stub" },
    configurable: true,
    writable: true,
  })
}

const uninstallWindow = (): void => {
  delete (globalThis as unknown as { window?: unknown }).window
}

const fixedAt = 1_715_000_000_000

const debugEvent = (): DevEventWithSeverity => ({
  kind: "FetchStart",
  traceId: "t",
  method: "GET",
  path: "/x",
  at: fixedAt,
  severity: "debug",
})

const errorEvent = (): DevEventWithSeverity => ({
  kind: "FetchError",
  traceId: "t",
  method: "GET",
  path: "/x",
  reason: "boom",
  at: fixedAt,
  severity: "error",
})

const warningEvent = (): DevEventWithSeverity => ({
  kind: "WsClose",
  code: 4429,
  reason: "rate-limit",
  wasClean: true,
  at: fixedAt,
  severity: "warning",
})

describe("reporter — severity gating", () => {
  let originalFetch: typeof fetch
  let fetchMock: FetchMock

  beforeEach(() => {
    __resetReporter()
    installWindow(makeStorage())
    originalFetch = globalThis.fetch
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
    __resetReporter()
    uninstallWindow()
  })

  it("does NOT ship debug events", () => {
    reportEvent(debugEvent())
    vi.advanceTimersByTime(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does NOT ship info events", () => {
    const info: DevEventWithSeverity = {
      kind: "WsOpen",
      at: fixedAt,
      severity: "info",
    }
    reportEvent(info)
    vi.advanceTimersByTime(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("ships warning events", () => {
    reportEvent(warningEvent())
    vi.advanceTimersByTime(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("ships error events", () => {
    reportEvent(errorEvent())
    vi.advanceTimersByTime(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("reporter — coalesce window", () => {
  let originalFetch: typeof fetch
  let fetchMock: FetchMock

  beforeEach(() => {
    __resetReporter()
    installWindow(makeStorage())
    originalFetch = globalThis.fetch
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
    __resetReporter()
    uninstallWindow()
  })

  it("batches multiple errors inside the 1s window into one POST", () => {
    reportEvent(errorEvent())
    reportEvent(errorEvent())
    reportEvent(warningEvent())
    expect(fetchMock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as {
      events: DevEventWithSeverity[]
      sessionId: string
      ua: string
    }
    expect(body.events).toHaveLength(3)
    expect(body.sessionId).toMatch(/^[0-9a-z]{26}$/)
    expect(body.ua).toBe("vitest-stub")
  })

  it("posts to /api/v1/__/client-error with keepalive", () => {
    reportEvent(errorEvent())
    vi.advanceTimersByTime(1000)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/v1/__/client-error")
    expect(init.method).toBe("POST")
    expect((init as { keepalive?: boolean }).keepalive).toBe(true)
  })

  it("emits separate POSTs across two windows", () => {
    reportEvent(errorEvent())
    vi.advanceTimersByTime(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    reportEvent(errorEvent())
    vi.advanceTimersByTime(1000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe("reporter — fire-and-forget", () => {
  let originalFetch: typeof fetch
  let originalConsole: typeof console.error

  beforeEach(() => {
    __resetReporter()
    installWindow(makeStorage())
    originalFetch = globalThis.fetch
    originalConsole = console.error
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
    console.error = originalConsole
    __resetReporter()
    uninstallWindow()
  })

  it("console.errors on fetch reject but does not throw", async () => {
    const errSpy = vi.fn()
    console.error = errSpy
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"))

    reportEvent(errorEvent())
    vi.advanceTimersByTime(1000)
    // Flush the microtask queue from the rejected fetch
    await vi.runAllTimersAsync()
    expect(errSpy).toHaveBeenCalled()
  })
})

describe("reporter — sanitisation", () => {
  let originalFetch: typeof fetch
  let fetchMock: FetchMock

  beforeEach(() => {
    __resetReporter()
    installWindow(makeStorage())
    originalFetch = globalThis.fetch
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
    __resetReporter()
    uninstallWindow()
  })

  it("redacts nameKana / phoneLast4 / freeText if present", () => {
    // Construct an event with extra PII fields. The runtime types
    // do not include these on the discriminated union, but the
    // sanitiser must still strip them defensively (the runtime data
    // graph may grow extras across deploys).
    const polluted = {
      ...errorEvent(),
      nameKana: "ヤマダ",
      phoneLast4: "1234",
      freeText: "secret note",
    } as unknown as DevEventWithSeverity
    reportEvent(polluted)
    __flushNow()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as {
      events: Record<string, unknown>[]
    }
    expect(body.events[0]?.nameKana).toBe("<redacted>")
    expect(body.events[0]?.phoneLast4).toBe("<redacted>")
    expect(body.events[0]?.freeText).toBe("<redacted>")
    expect(body.events[0]?.reason).toBe("boom")
  })

  it("recursively sanitises nested objects + arrays", () => {
    const polluted = {
      ...errorEvent(),
      meta: { nested: { nameKana: "ヤマダ" }, list: [{ phoneLast4: "9999" }] },
    } as unknown as DevEventWithSeverity
    reportEvent(polluted)
    __flushNow()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as {
      events: {
        meta: { nested: { nameKana: string }; list: { phoneLast4: string }[] }
      }[]
    }
    expect(body.events[0]?.meta.nested.nameKana).toBe("<redacted>")
    expect(body.events[0]?.meta.list[0]?.phoneLast4).toBe("<redacted>")
  })
})

describe("reporter — session id persistence", () => {
  let originalFetch: typeof fetch
  let fetchMock: FetchMock
  let storage: Storage

  beforeEach(() => {
    __resetReporter()
    storage = makeStorage()
    installWindow(storage)
    originalFetch = globalThis.fetch
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
    __resetReporter()
    uninstallWindow()
  })

  it("reuses the same sessionId across two batches", () => {
    reportEvent(errorEvent())
    __flushNow()
    reportEvent(errorEvent())
    __flushNow()
    const [, init1] = fetchMock.mock.calls[0] as [string, RequestInit]
    const [, init2] = fetchMock.mock.calls[1] as [string, RequestInit]
    const id1 = (JSON.parse(init1.body as string) as { sessionId: string }).sessionId
    const id2 = (JSON.parse(init2.body as string) as { sessionId: string }).sessionId
    expect(id1).toBe(id2)
    expect(storage.getItem("obs.sessionId.v1")).toBe(id1)
  })

  it("reads existing sessionId from storage", () => {
    storage.setItem("obs.sessionId.v1", "preloadedsessionidvalue123")
    reportEvent(errorEvent())
    __flushNow()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const id = (JSON.parse(init.body as string) as { sessionId: string }).sessionId
    expect(id).toBe("preloadedsessionidvalue123")
  })
})

describe("reporter — SSR / no-fetch branches", () => {
  beforeEach(() => {
    __resetReporter()
  })

  afterEach(() => {
    __resetReporter()
    uninstallWindow()
  })

  it("flush is a no-op when window is undefined", () => {
    uninstallWindow()
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    reportEvent(errorEvent())
    __flushNow()
    expect(fetchMock).not.toHaveBeenCalled()
    globalThis.fetch = originalFetch
  })

  it("__flushNow with empty buffer is a no-op", () => {
    installWindow(makeStorage())
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    __flushNow()
    expect(fetchMock).not.toHaveBeenCalled()
    globalThis.fetch = originalFetch
  })

  it("handles sessionStorage.setItem throw on session-id persist", () => {
    const throwing = makeStorageWith({
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked")
      },
    })
    installWindow(throwing)
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    globalThis.fetch = fetchMock
    expect(() => {
      reportEvent(errorEvent())
      __flushNow()
    }).not.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    globalThis.fetch = originalFetch
  })

  it("falls back to fresh sessionId when sessionStorage.getItem throws", () => {
    const throwing = makeStorageWith({
      getItem: () => {
        throw new Error("blocked")
      },
    })
    installWindow(throwing)
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    globalThis.fetch = fetchMock
    reportEvent(errorEvent())
    __flushNow()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { sessionId: string }
    expect(body.sessionId).toMatch(/^[0-9a-z]{26}$/)
    globalThis.fetch = originalFetch
  })

  it("falls back to 'unknown' ua when navigator missing", () => {
    ;(globalThis as unknown as { window: { sessionStorage: Storage } }).window = {
      sessionStorage: makeStorage(),
    }
    const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator")
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
      writable: true,
    })
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    globalThis.fetch = fetchMock
    reportEvent(errorEvent())
    __flushNow()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { ua: string }
    expect(body.ua).toBe("unknown")
    globalThis.fetch = originalFetch
    if (navDesc !== undefined) Object.defineProperty(globalThis, "navigator", navDesc)
  })
})
