import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  isTerminalState,
  purgeTicketCache,
  readTicketCache,
  writeTicketCache,
} from "../src/lib/ticketCache.js"

/**
 * ADR-0069 ticket cache contract pin. The unit covers four
 * boundaries: round-trip read/write, TTL self-purge after 24h,
 * legacy `queue.ticket` sessionStorage migration, and terminal-
 * state detection.
 *
 * Vitest's `node` environment doesn't ship `window.localStorage` /
 * `sessionStorage` natively, so each test wires a minimal in-memory
 * Storage polyfill via vi.stubGlobal.
 */

const makeStorage = (): Storage => {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => {
      data.clear()
    },
    getItem: (k) => data.get(k) ?? null,
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => {
      data.delete(k)
    },
    setItem: (k, v) => {
      data.set(k, v)
    },
  }
}

beforeEach(() => {
  const localStorage = makeStorage()
  const sessionStorage = makeStorage()
  vi.stubGlobal("window", {
    localStorage,
    sessionStorage,
    location: { origin: "https://test.invalid" },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("ADR-0069 ticket cache", () => {
  it("round-trips writeTicketCache → readTicketCache", () => {
    writeTicketCache({
      ticketId: "tkt_x",
      nameKana: "ヤマダ タロウ",
      phoneLast4: "1234",
      lastKnownState: "Waiting",
    })
    const back = readTicketCache()
    expect(back).not.toBeNull()
    expect(back?.ticketId).toBe("tkt_x")
    expect(back?.nameKana).toBe("ヤマダ タロウ")
    expect(back?.phoneLast4).toBe("1234")
    expect(back?.lastKnownState).toBe("Waiting")
    expect(typeof back?.cachedAt).toBe("number")
  })

  it("purgeTicketCache deletes the entry", () => {
    writeTicketCache({ ticketId: "tkt_x", nameKana: "ヤ", phoneLast4: "1234" })
    expect(readTicketCache()).not.toBeNull()
    purgeTicketCache()
    expect(readTicketCache()).toBeNull()
  })

  it("entries older than 24h self-purge on read", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-10T00:00:00Z"))
    writeTicketCache({ ticketId: "tkt_old", nameKana: "ヤ", phoneLast4: "1234" })
    // +25 hours
    vi.setSystemTime(new Date("2026-05-11T01:00:00Z"))
    expect(readTicketCache()).toBeNull()
  })

  it("migrates the legacy sessionStorage queue.ticket entry", () => {
    const w = window as unknown as { sessionStorage: Storage; localStorage: Storage }
    w.sessionStorage.setItem(
      "queue.ticket",
      JSON.stringify({ ticketId: "tkt_legacy", nameKana: "ヤ", phoneLast4: "9999" }),
    )
    const migrated = readTicketCache()
    expect(migrated?.ticketId).toBe("tkt_legacy")
    expect(migrated?.phoneLast4).toBe("9999")
    // Legacy key deleted post-migration.
    expect(w.sessionStorage.getItem("queue.ticket")).toBeNull()
    // New key written.
    expect(w.localStorage.getItem("queue.ticket.v2")).not.toBeNull()
  })

  it("isTerminalState recognises Served / Cancelled / NoShow", () => {
    expect(isTerminalState("Served")).toBe(true)
    expect(isTerminalState("Cancelled")).toBe(true)
    expect(isTerminalState("NoShow")).toBe(true)
    expect(isTerminalState("Waiting")).toBe(false)
    expect(isTerminalState("Called")).toBe(false)
    // ADR-0072: Overdue is active (non-terminal). ADR-0071 removed Serving.
    expect(isTerminalState("Overdue")).toBe(false)
    expect(isTerminalState("CheckedIn")).toBe(false)
  })

  it("returns null for malformed payloads", () => {
    const w = window as unknown as { localStorage: Storage }
    w.localStorage.setItem("queue.ticket.v2", "not-json")
    expect(readTicketCache()).toBeNull()
    w.localStorage.setItem("queue.ticket.v2", JSON.stringify({ ticketId: 42 }))
    expect(readTicketCache()).toBeNull()
  })
})
