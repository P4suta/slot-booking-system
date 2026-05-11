import { writable } from "svelte/store"
import type { QueueFeedState as LegacyQueueFeedState } from "./api.js"
import { fromLegacy, type QueueFeedState } from "./queueFeedMachine.js"

/**
 * App-wide WebSocket connection status. Each route that opens a
 * `connectQueueFeed` writes its `onState` events through this
 * store so the layout header can render a single canonical chip
 * — the customer screen and the staff dashboard then surface the
 * same "サーバ通信" indicator at the same place (ADR-0061 broadcast
 * feed is shared infrastructure; the visual representation
 * should match).
 *
 * The store value is the {@link QueueFeedState} discriminated
 * union from `queueFeedMachine` (S19 / ADR-0087). Writers that
 * still hand a legacy `"connecting" | "open" | …` string lift
 * through {@link writeLegacyStatus}; the Moore machine outputs
 * (`label`, `tone`) drive the rendered chip.
 *
 * `null` means the current route has no WS subscription, so the
 * layout chip should not render at all. The default is `null` so
 * pages like `/issue` and `/recover` (which don't open a feed)
 * don't leave the chip stuck on "接続中..." forever.
 *
 * Writers: `/+page.svelte`, `/ticket/+page.svelte`,
 * `/staff/+page.svelte` (mirror onState into the store; reset
 * to `null` on unmount). `/issue/+page.svelte` and
 * `/recover/+page.svelte` reset to `null` on mount.
 * Reader: `+layout.svelte` (header chip; hidden when `null`).
 */
export type WsDisplayState = QueueFeedState | null

export const wsStatus = writable<WsDisplayState>(null)

/** Bridge for callers still passing the legacy string union. */
export const writeLegacyStatus = (legacy: LegacyQueueFeedState | "none" | null): void => {
  if (legacy === null || legacy === "none") {
    wsStatus.set(null)
    return
  }
  wsStatus.set(fromLegacy(legacy))
}
