/**
 * Broadcaster — coalescing WebSocket fan-out with per-capability
 * frame variants.
 *
 * On `publish()` a single `coalesceMs` timer collects every
 * dispatch that lands inside the window into one broadcast. When
 * the timer fires the broadcaster:
 *
 *   1. computes the next anonymous + staff projections via
 *      caller-supplied builders,
 *   2. advances the VectorClock once per fan-out,
 *   3. for each attached socket, looks up the capability tag and
 *      sends the matching variant (snapshot on the first fan-out
 *      against `null`, delta thereafter; an empty delta is
 *      skipped).
 *
 * Two separate snapshot caches (`lastAnon`, `lastStaff`) are
 * needed because the two frame variants diverge on PII fields,
 * but they share a VectorClock so cross-capability gap detection
 * stays meaningful.
 *
 * The PII-bearing staff frame builder is hand-invoked on every
 * fan-out rather than derived from the anonymous frame so the
 * boundary stays explicit: the anonymous wire never sees
 * `nameKana`/`phoneLast4`/`freeText` (ADR-0009 logging-PII
 * discipline + ADR-0083 inside-boundary split).
 */
import {
  computeShopStateDelta,
  computeStaffShopStateDelta,
  type FeedMessage,
  isEmptyShopStateDelta,
  isEmptyStaffShopStateDelta,
  type ShopState,
  type StaffShopState,
  VectorClock,
} from "@booking/core"
import { logWsError } from "./wsLifecycleLog.js"

export type BroadcasterCapability = "anonymous" | "staff"

export const CAPABILITY_TAG_PREFIX = "cap:"

const capabilityFromTags = (tags: readonly string[]): BroadcasterCapability => {
  for (const tag of tags) {
    if (tag === `${CAPABILITY_TAG_PREFIX}staff`) return "staff"
  }
  return "anonymous"
}

export type BroadcasterDeps = {
  /** Identifier the {@link VectorClock} advances under. */
  readonly siteId: string
  /** Returns the current set of attached sockets. */
  readonly getWebSockets: () => readonly WebSocket[]
  /** Tag lookup for a socket (Cloudflare DO `state.getTags`). */
  readonly getTags: (ws: WebSocket) => readonly string[]
  /** Window in ms; dispatches inside it coalesce into one fan-out. */
  readonly coalesceMs: number
  /** Build the anonymous payload on demand. */
  readonly buildAnonymous: () => Promise<ShopState>
  /** Build the staff (PII-bearing) payload on demand. */
  readonly buildStaff: () => Promise<StaffShopState>
  /** Reports send-failure metrics to the lifecycle log. */
  readonly onBroadcast: (sockets: number, durationMs: number, bytes: number, failed: number) => void
}

export class Broadcaster {
  private lastAnon: ShopState | null = null
  private lastStaff: StaffShopState | null = null
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined
  private vector: VectorClock = VectorClock.empty()

  constructor(private readonly deps: BroadcasterDeps) {}

  /** Initial snapshot for a freshly-accepted socket. */
  async connect(ws: WebSocket, capability: BroadcasterCapability): Promise<void> {
    try {
      if (capability === "staff") {
        const snapshot = this.lastStaff ?? (await this.deps.buildStaff())
        this.lastStaff = snapshot
        const msg: FeedMessage = {
          v: 6,
          kind: "snapshot",
          at: this.vector,
          capability: "staff",
          snapshot,
        }
        ws.send(JSON.stringify(msg))
      } else {
        const snapshot = this.lastAnon ?? (await this.deps.buildAnonymous())
        this.lastAnon = snapshot
        const msg: FeedMessage = {
          v: 6,
          kind: "snapshot",
          at: this.vector,
          capability: "anonymous",
          snapshot,
        }
        ws.send(JSON.stringify(msg))
      }
    } catch (err) {
      logWsError(`on-connect send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Coalescing publish — at most one fan-out per `coalesceMs`
   * window. Re-entrant calls inside an in-flight window are
   * folded into the same fan-out.
   */
  publish(): Promise<void> {
    if (this.coalesceTimer !== undefined) return Promise.resolve()
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined
      void this.fire()
    }, this.deps.coalesceMs)
    return Promise.resolve()
  }

  /** For tests + alarm rehydrate paths — bypass the coalesce timer. */
  async fireNow(): Promise<void> {
    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer)
      this.coalesceTimer = undefined
    }
    await this.fire()
  }

  private async fire(): Promise<void> {
    const sockets = this.deps.getWebSockets()
    const nextAnon = await this.deps.buildAnonymous()
    const nextStaff = await this.deps.buildStaff()
    if (sockets.length === 0) {
      this.lastAnon = nextAnon
      this.lastStaff = nextStaff
      return
    }
    const prevVector = this.vector
    const nextVector = VectorClock.tick(prevVector, this.deps.siteId)
    const anonPayload = encodeAnonymousPayload(this.lastAnon, nextAnon, prevVector, nextVector)
    const staffPayload = encodeStaffPayload(this.lastStaff, nextStaff, prevVector, nextVector)
    this.lastAnon = nextAnon
    this.lastStaff = nextStaff
    // Only advance the VectorClock when at least one capability has
    // something to send; an empty diff for both is a no-op fan-out.
    if (anonPayload === null && staffPayload === null) return
    this.vector = nextVector
    const startedAt = Date.now()
    let totalBytes = 0
    let failed = 0
    for (const ws of sockets) {
      const capability = capabilityFromTags(this.deps.getTags(ws))
      const payload = capability === "staff" ? staffPayload : anonPayload
      if (payload === null) continue
      try {
        ws.send(payload)
        totalBytes += payload.length
      } catch (err) {
        failed += 1
        logWsError(`broadcast send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.deps.onBroadcast(sockets.length, Date.now() - startedAt, totalBytes, failed)
  }
}

const encodeAnonymousPayload = (
  prev: ShopState | null,
  next: ShopState,
  prevVector: VectorClock,
  nextVector: VectorClock,
): string | null => {
  if (prev === null) {
    const msg: FeedMessage = {
      v: 6,
      kind: "snapshot",
      at: nextVector,
      capability: "anonymous",
      snapshot: next,
    }
    return JSON.stringify(msg)
  }
  const delta = computeShopStateDelta(prev, next)
  if (isEmptyShopStateDelta(delta)) return null
  const msg: FeedMessage = {
    v: 6,
    kind: "delta",
    at: nextVector,
    since: prevVector,
    capability: "anonymous",
    delta,
  }
  return JSON.stringify(msg)
}

const encodeStaffPayload = (
  prev: StaffShopState | null,
  next: StaffShopState,
  prevVector: VectorClock,
  nextVector: VectorClock,
): string | null => {
  if (prev === null) {
    const msg: FeedMessage = {
      v: 6,
      kind: "snapshot",
      at: nextVector,
      capability: "staff",
      snapshot: next,
    }
    return JSON.stringify(msg)
  }
  const delta = computeStaffShopStateDelta(prev, next)
  if (isEmptyStaffShopStateDelta(delta)) return null
  const msg: FeedMessage = {
    v: 6,
    kind: "delta",
    at: nextVector,
    since: prevVector,
    capability: "staff",
    delta,
  }
  return JSON.stringify(msg)
}
