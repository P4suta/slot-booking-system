/**
 * Client-side ticket cache (ADR-0069). The customer's `localStorage`
 * holds the (ticketId, handle) tuple from the most recent issue or
 * recovery so a same-device reopen avoids the by-handle round-trip
 * entirely on the first paint.
 *
 * Hierarchy:
 *
 *   - server-side `GET /api/v1/tickets/by-handle` is the **primary**
 *     recovery capability — the cache is just convenience.
 *   - `/ticket` route boots stale-while-revalidate: render from
 *     localStorage, then revalidate via by-handle, purge on
 *     terminal-state observation or mismatch.
 *
 * The previous ADR-0064 cache lived in `sessionStorage` under
 * `queue.ticket`; this key (`queue.ticket.v2`) lives in
 * `localStorage` so a tab close / browser restart still picks up
 * the active ticket. A one-cycle migration reads the legacy key on
 * boot when the new key is empty.
 */

const NEW_KEY = "queue.ticket.v2"
const LEGACY_KEY = "queue.ticket"

/**
 * Time-to-live for the cache. Active tickets rarely sit longer than
 * the operator's open hours; 24 h is the upper bound of a single
 * service session. After 24 h the cache self-purges so a fresh
 * by-handle lookup is forced.
 */
const TTL_MS = 24 * 60 * 60 * 1000

export type CachedTicket = {
  readonly ticketId: string
  readonly nameKana: string
  readonly phoneLast4: string
  readonly cachedAt: number
  readonly lastKnownState?: string
}

const isCachedTicket = (v: unknown): v is CachedTicket => {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.ticketId === "string" &&
    typeof o.nameKana === "string" &&
    typeof o.phoneLast4 === "string" &&
    typeof o.cachedAt === "number"
  )
}

const readKey = (key: string): CachedTicket | null => {
  if (typeof window === "undefined") return null
  const raw = window.localStorage.getItem(key)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isCachedTicket(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Read the cached ticket if any. Falls back to the legacy
 * `sessionStorage.queue.ticket` (ADR-0064) for one release cycle:
 * on a hit we migrate the value into the new localStorage key and
 * delete the legacy entry.
 *
 * Self-purges entries older than {@link TTL_MS}.
 */
export const readTicketCache = (): CachedTicket | null => {
  const fresh = readKey(NEW_KEY)
  if (fresh !== null) {
    if (Date.now() - fresh.cachedAt > TTL_MS) {
      purgeTicketCache()
      return null
    }
    return fresh
  }
  // Legacy migration: ADR-0064's sessionStorage cache had no
  // cachedAt and lived under "queue.ticket".
  if (typeof window === "undefined") return null
  const legacyRaw = window.sessionStorage.getItem(LEGACY_KEY)
  if (legacyRaw === null) return null
  try {
    const parsed: unknown = JSON.parse(legacyRaw)
    if (typeof parsed !== "object" || parsed === null) return null
    const o = parsed as Record<string, unknown>
    if (
      typeof o.ticketId !== "string" ||
      typeof o.nameKana !== "string" ||
      typeof o.phoneLast4 !== "string"
    ) {
      return null
    }
    const migrated: CachedTicket = {
      ticketId: o.ticketId,
      nameKana: o.nameKana,
      phoneLast4: o.phoneLast4,
      cachedAt: Date.now(),
    }
    writeTicketCache(migrated)
    window.sessionStorage.removeItem(LEGACY_KEY)
    return migrated
  } catch {
    return null
  }
}

/** Write the cache entry. Overwrites any prior value. */
export const writeTicketCache = (entry: {
  readonly ticketId: string
  readonly nameKana: string
  readonly phoneLast4: string
  readonly lastKnownState?: string
}): void => {
  if (typeof window === "undefined") return
  const payload: CachedTicket = {
    ticketId: entry.ticketId,
    nameKana: entry.nameKana,
    phoneLast4: entry.phoneLast4,
    cachedAt: Date.now(),
    ...(entry.lastKnownState !== undefined ? { lastKnownState: entry.lastKnownState } : {}),
  }
  window.localStorage.setItem(NEW_KEY, JSON.stringify(payload))
}

/** Drop the cache entry (also clears the legacy sessionStorage key). */
export const purgeTicketCache = (): void => {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(NEW_KEY)
  window.sessionStorage.removeItem(LEGACY_KEY)
}

/**
 * Terminal states release the handle (ADR-0069 §Active set). The
 * cache must purge on observation of a terminal transition so a
 * subsequent boot does not surface the stale id.
 */
const TERMINAL_STATES: readonly string[] = ["Served", "Cancelled", "NoShow"] as const

export const isTerminalState = (state: string): boolean => TERMINAL_STATES.includes(state)
