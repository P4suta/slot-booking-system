/**
 * Bounded ring buffer with sessionStorage persistence (Stage 20 /
 * ADR-0088).
 *
 * The structure is a circular array of fixed size {@link RING_SIZE}
 * with a `head` write pointer and a saturating `count`. Push is
 * O(1); snapshot is O(n) walking from the oldest slot
 * (`(head − count + n) mod n`) so the caller always sees the
 * chronological order without an explicit sort.
 *
 * Persistence: every push mirrors the snapshot into `sessionStorage`
 * so a page reload keeps the last 256 events visible to whoever
 * pops the dev console. We persist the *array* form (already
 * chronological) rather than the internal `(buffer, head, count)`
 * triple — the deserialised view is the canonical one, and the
 * legacy in-memory pointers are reconstructed lazily on the next
 * push. The cost of one `JSON.stringify` per emit is acceptable at
 * 256 cap (events average ~200 bytes → ~50 KB worst case, well
 * under the 5 MB sessionStorage budget); a future optimisation
 * could throttle the write to rAF without changing the API.
 *
 * SSR safety: every `sessionStorage` access is guarded by
 * `typeof window !== "undefined"`. SvelteKit runs the module at
 * load-time on the server during +page.server hydration; without
 * the guard the import alone would throw.
 *
 * The factory returns a fresh ring per call so tests can isolate
 * state without monkey-patching a module singleton. The exported
 * `obsRing` from `bus.ts` is the process-wide instance.
 */

export type Ring<T> = {
  readonly push: (entry: T) => void
  readonly snapshot: () => readonly T[]
  readonly clear: () => void
}

export const RING_SIZE = 256

export const SESSION_KEY = "obs.ring.v1"

const hasSessionStorage = (): boolean => {
  if (typeof window === "undefined") return false
  try {
    return typeof window.sessionStorage !== "undefined"
  } catch {
    // Browsers in privacy mode (Safari historically) throw on the
    // access itself; treat that as "no storage" rather than crashing
    // the obs module.
    return false
  }
}

const restoreFromSession = (): readonly unknown[] => {
  if (!hasSessionStorage()) return []
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // We trust the shape because the only writer is `persist()` below.
    // A malformed value (manual tampering, schema drift across a
    // deploy) is treated as "no history" rather than throwing — the
    // ring's job is best-effort.
    return parsed
  } catch {
    return []
  }
}

const persist = (entries: readonly unknown[]): void => {
  if (!hasSessionStorage()) return
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(entries))
  } catch {
    // QuotaExceededError or a serialisation cycle: drop silently.
    // The in-memory ring stays correct; only persistence is lost.
  }
}

export const createRing = <T>(): Ring<T> => {
  const buffer: (T | undefined)[] = new Array<T | undefined>(RING_SIZE)
  let head = 0
  let count = 0

  // Best-effort restore from sessionStorage at construction time so
  // a page reload keeps history. Restoration is bounded by RING_SIZE
  // — anything longer (shouldn't happen, but defends against a hand-
  // edited value) is truncated to the tail.
  const restored = restoreFromSession() as readonly T[]
  const restoredStart = Math.max(0, restored.length - RING_SIZE)
  for (let i = restoredStart; i < restored.length; i += 1) {
    buffer[head] = restored[i]
    head = (head + 1) % RING_SIZE
    if (count < RING_SIZE) count += 1
  }

  const collectSnapshot = (): readonly T[] => {
    const out: T[] = []
    const start = (head - count + RING_SIZE) % RING_SIZE
    for (let i = 0; i < count; i += 1) {
      const slot = buffer[(start + i) % RING_SIZE]
      // `slot` is non-undefined for indices `< count` by construction,
      // but TS can't prove it through the partial array. The cast is
      // narrowed by the `count` invariant rather than `as` escape.
      if (slot !== undefined) out.push(slot)
    }
    return out
  }

  return {
    push: (entry: T): void => {
      buffer[head] = entry
      head = (head + 1) % RING_SIZE
      if (count < RING_SIZE) count += 1
      persist(collectSnapshot())
    },
    snapshot: collectSnapshot,
    clear: (): void => {
      head = 0
      count = 0
      for (let i = 0; i < RING_SIZE; i += 1) buffer[i] = undefined
      if (hasSessionStorage()) {
        try {
          window.sessionStorage.removeItem(SESSION_KEY)
        } catch {
          // ignore — same rationale as `persist`.
        }
      }
    },
  }
}
