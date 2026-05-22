import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearStaffSession,
  hasStaffSession,
  persistStaffSession,
  readStoredSession,
  STAFF_TOKEN_STORAGE_KEY,
} from "../../src/lib/staffSession.js"

/**
 * Staff session state-machine contract pin. The implementation is
 * small but load-bearing: the page binds a `<input bind:value>` to a
 * separate form field and uses these functions to gate the
 * authenticated-or-not flag. A regression that lets `persistStaffSession`
 * accept an empty token, or removes the `localStorage` write, would
 * silently revive the auth-bypass bug that prompted the extraction
 * (typing a single character into the password box used to flip the
 * dashboard on; see the leading comment in `lib/staffSession.ts`).
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
  vi.stubGlobal("window", { localStorage: makeStorage() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("staffSession state machine", () => {
  describe("readStoredSession", () => {
    it("returns anonymous when localStorage is empty", () => {
      expect(readStoredSession()).toEqual({ kind: "anonymous" })
    })

    it("returns authenticated with the stored token when present", () => {
      window.localStorage.setItem(STAFF_TOKEN_STORAGE_KEY, "abc")
      expect(readStoredSession()).toEqual({ kind: "authenticated", token: "abc" })
    })

    it("treats an empty-string stored value as anonymous", () => {
      // localStorage cannot store undefined, but a previous version
      // could leave `""` if anything ever bypassed the persist guard.
      // The reader must still report anonymous so the page does not
      // render the dashboard for a useless credential.
      window.localStorage.setItem(STAFF_TOKEN_STORAGE_KEY, "")
      expect(readStoredSession()).toEqual({ kind: "anonymous" })
    })
  })

  describe("hasStaffSession", () => {
    it("is false for the initial empty state", () => {
      expect(hasStaffSession()).toBe(false)
    })

    it("is true once a non-empty token is stored", () => {
      window.localStorage.setItem(STAFF_TOKEN_STORAGE_KEY, "abc")
      expect(hasStaffSession()).toBe(true)
    })

    it("is false again after clearStaffSession", () => {
      window.localStorage.setItem(STAFF_TOKEN_STORAGE_KEY, "abc")
      clearStaffSession()
      expect(hasStaffSession()).toBe(false)
    })
  })

  describe("persistStaffSession", () => {
    it("writes the token to localStorage and returns authenticated", () => {
      const s = persistStaffSession("xyz")
      expect(s).toEqual({ kind: "authenticated", token: "xyz" })
      expect(window.localStorage.getItem(STAFF_TOKEN_STORAGE_KEY)).toBe("xyz")
    })

    it("trims surrounding whitespace before persisting", () => {
      const s = persistStaffSession("  xyz  ")
      expect(s).toEqual({ kind: "authenticated", token: "xyz" })
      expect(window.localStorage.getItem(STAFF_TOKEN_STORAGE_KEY)).toBe("xyz")
    })

    it("throws on empty token and writes nothing", () => {
      expect(() => persistStaffSession("")).toThrow(/non-empty/)
      expect(window.localStorage.getItem(STAFF_TOKEN_STORAGE_KEY)).toBeNull()
    })

    it("throws on whitespace-only token and writes nothing", () => {
      expect(() => persistStaffSession("   ")).toThrow(/non-empty/)
      expect(window.localStorage.getItem(STAFF_TOKEN_STORAGE_KEY)).toBeNull()
    })

    it("overwrites a prior credential on re-persist", () => {
      persistStaffSession("first")
      const s = persistStaffSession("second")
      expect(s).toEqual({ kind: "authenticated", token: "second" })
      expect(window.localStorage.getItem(STAFF_TOKEN_STORAGE_KEY)).toBe("second")
    })
  })

  describe("clearStaffSession", () => {
    it("removes the token and returns anonymous", () => {
      window.localStorage.setItem(STAFF_TOKEN_STORAGE_KEY, "xyz")
      const s = clearStaffSession()
      expect(s).toEqual({ kind: "anonymous" })
      expect(window.localStorage.getItem(STAFF_TOKEN_STORAGE_KEY)).toBeNull()
    })

    it("is idempotent on an already-anonymous state", () => {
      expect(() => clearStaffSession()).not.toThrow()
      expect(window.localStorage.getItem(STAFF_TOKEN_STORAGE_KEY)).toBeNull()
    })
  })

  describe("round-trip", () => {
    it("persist → readStoredSession reflects the same token", () => {
      persistStaffSession("round-trip-token")
      expect(readStoredSession()).toEqual({
        kind: "authenticated",
        token: "round-trip-token",
      })
    })

    it("persist → clear → readStoredSession returns to anonymous", () => {
      persistStaffSession("first")
      clearStaffSession()
      expect(readStoredSession()).toEqual({ kind: "anonymous" })
    })
  })
})
