import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createRing, RING_SIZE, SESSION_KEY } from "../../../src/lib/obs/ringBuffer.js"

/**
 * Stage 20 / ADR-0088 ring-buffer contract.
 *
 * The unit covers four invariants:
 *   - FIFO push / snapshot order (chronological)
 *   - overflow saturates at RING_SIZE keeping the newest N
 *   - sessionStorage persistence on every push, and restoration on
 *     construction (page reload simulation)
 *   - SSR safety (no `window` ⇒ push is a silent no-op for the
 *     persistence side, in-memory ring still works)
 */

type StorageOverrides = Partial<Pick<Storage, "getItem" | "setItem" | "removeItem">>

const makeStorageWith = (overrides: StorageOverrides): Storage => {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => {
      data.clear()
    },
    getItem: overrides.getItem ?? ((k: string) => data.get(k) ?? null),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem:
      overrides.removeItem ??
      ((k: string) => {
        data.delete(k)
      }),
    setItem:
      overrides.setItem ??
      ((k: string, v: string) => {
        data.set(k, v)
      }),
  }
}

const makeStorage = (): Storage => makeStorageWith({})

type WinShim = { sessionStorage: Storage }

const installWindow = (storage: Storage): void => {
  ;(globalThis as unknown as { window: WinShim }).window = { sessionStorage: storage }
}

const uninstallWindow = (): void => {
  delete (globalThis as unknown as { window?: WinShim }).window
}

describe("createRing — push / snapshot order", () => {
  beforeEach(() => {
    installWindow(makeStorage())
  })
  afterEach(uninstallWindow)

  it("returns entries in chronological order (oldest first)", () => {
    const ring = createRing<number>()
    ring.push(1)
    ring.push(2)
    ring.push(3)
    expect(ring.snapshot()).toEqual([1, 2, 3])
  })

  it("snapshot is empty for a fresh ring", () => {
    const ring = createRing<number>()
    expect(ring.snapshot()).toEqual([])
  })
})

describe("createRing — overflow", () => {
  beforeEach(() => {
    installWindow(makeStorage())
  })
  afterEach(uninstallWindow)

  it("saturates at RING_SIZE keeping the newest N", () => {
    const ring = createRing<number>()
    for (let i = 0; i < RING_SIZE + 50; i += 1) ring.push(i)
    const snap = ring.snapshot()
    expect(snap).toHaveLength(RING_SIZE)
    expect(snap[0]).toBe(50)
    expect(snap[snap.length - 1]).toBe(RING_SIZE + 49)
  })

  it("clear() empties the ring + sessionStorage", () => {
    const storage = makeStorage()
    installWindow(storage)
    const ring = createRing<number>()
    ring.push(1)
    ring.push(2)
    expect(ring.snapshot()).toEqual([1, 2])
    ring.clear()
    expect(ring.snapshot()).toEqual([])
    expect(storage.getItem(SESSION_KEY)).toBeNull()
  })
})

describe("createRing — sessionStorage persistence", () => {
  it("writes the chronological array on every push", () => {
    const storage = makeStorage()
    installWindow(storage)
    const ring = createRing<{ n: number }>()
    ring.push({ n: 1 })
    ring.push({ n: 2 })
    const raw = storage.getItem(SESSION_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw ?? "[]")).toEqual([{ n: 1 }, { n: 2 }])
  })

  it("restores from sessionStorage on construction", () => {
    const storage = makeStorage()
    storage.setItem(SESSION_KEY, JSON.stringify([{ n: 10 }, { n: 11 }]))
    installWindow(storage)
    const ring = createRing<{ n: number }>()
    expect(ring.snapshot()).toEqual([{ n: 10 }, { n: 11 }])
  })

  it("ignores malformed sessionStorage payload", () => {
    const storage = makeStorage()
    storage.setItem(SESSION_KEY, "not-json")
    installWindow(storage)
    const ring = createRing<{ n: number }>()
    expect(ring.snapshot()).toEqual([])
  })

  it("ignores non-array sessionStorage payload", () => {
    const storage = makeStorage()
    storage.setItem(SESSION_KEY, JSON.stringify({ not: "an array" }))
    installWindow(storage)
    const ring = createRing<{ n: number }>()
    expect(ring.snapshot()).toEqual([])
  })

  it("truncates oversize restored payload to RING_SIZE", () => {
    const storage = makeStorage()
    const big = Array.from({ length: RING_SIZE + 30 }, (_, i) => ({ n: i }))
    storage.setItem(SESSION_KEY, JSON.stringify(big))
    installWindow(storage)
    const ring = createRing<{ n: number }>()
    const snap = ring.snapshot()
    expect(snap).toHaveLength(RING_SIZE)
    expect(snap[0]).toEqual({ n: 30 })
  })

  it("swallows sessionStorage.setItem quota errors", () => {
    const throwing = makeStorageWith({
      setItem: () => {
        throw new Error("QuotaExceeded")
      },
    })
    installWindow(throwing)
    const ring = createRing<number>()
    expect(() => {
      ring.push(1)
    }).not.toThrow()
    // In-memory state still correct
    expect(ring.snapshot()).toEqual([1])
  })

  it("swallows sessionStorage.getItem throw on restore", () => {
    const throwing = makeStorageWith({
      getItem: () => {
        throw new Error("blocked")
      },
    })
    installWindow(throwing)
    const ring = createRing<number>()
    expect(ring.snapshot()).toEqual([])
  })

  it("swallows sessionStorage.removeItem throw on clear", () => {
    const throwing = makeStorageWith({
      removeItem: () => {
        throw new Error("blocked")
      },
    })
    installWindow(throwing)
    const ring = createRing<number>()
    ring.push(1)
    expect(() => {
      ring.clear()
    }).not.toThrow()
    expect(ring.snapshot()).toEqual([])
  })
})

describe("createRing — SSR safety", () => {
  beforeEach(() => {
    uninstallWindow()
  })

  it("push is a no-op for persistence when window is undefined", () => {
    const ring = createRing<number>()
    expect(() => {
      ring.push(1)
    }).not.toThrow()
    expect(ring.snapshot()).toEqual([1])
  })

  it("clear works without window", () => {
    const ring = createRing<number>()
    ring.push(42)
    ring.clear()
    expect(ring.snapshot()).toEqual([])
  })

  it("handles window without sessionStorage gracefully", () => {
    ;(globalThis as unknown as { window: object }).window = {}
    const ring = createRing<number>()
    expect(() => {
      ring.push(1)
    }).not.toThrow()
    expect(ring.snapshot()).toEqual([1])
    uninstallWindow()
  })

  it("treats a sessionStorage access throw as missing storage", () => {
    const blocked = new Proxy(
      {},
      {
        get: (_t, p) => {
          if (p === "sessionStorage") throw new Error("blocked")
          return undefined
        },
      },
    )
    ;(globalThis as unknown as { window: object }).window = blocked
    const ring = createRing<number>()
    expect(() => {
      ring.push(1)
    }).not.toThrow()
    expect(ring.snapshot()).toEqual([1])
    uninstallWindow()
  })
})

describe("createRing — cyclic overflow chronological order", () => {
  it("after wrap-around snapshot is still oldest-first", () => {
    installWindow(makeStorage())
    const ring = createRing<number>()
    // Push 1.5x the ring size; the first RING_SIZE/2 entries get
    // overwritten, the remaining entries should appear in push order.
    const total = RING_SIZE + Math.floor(RING_SIZE / 2)
    for (let i = 0; i < total; i += 1) ring.push(i)
    const snap = ring.snapshot()
    expect(snap[0]).toBe(total - RING_SIZE)
    expect(snap[snap.length - 1]).toBe(total - 1)
    uninstallWindow()
  })
})
