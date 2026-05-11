import { writable } from "svelte/store"
import type { QueueFeedState } from "./api.js"

/**
 * App-wide WebSocket connection status. Each route that opens a
 * `connectQueueFeed` writes its `onState` events through this store
 * so the layout header can render a single canonical chip — the
 * customer screen and the staff dashboard then surface the same
 * "サーバ通信" indicator at the same place (ADR-0061 broadcast feed
 * is shared infrastructure; the visual representation should match).
 *
 * `"none"` means the current route has no WS subscription, so the
 * layout chip should not render at all. The default is `"none"` so
 * pages like `/issue` and `/recover` (which don't open a feed) don't
 * leave the chip stuck on "接続中…" forever — they would otherwise
 * never call `wsStatus.set(...)` and the store would retain the
 * value from the previous route or the initial "connecting".
 *
 * Writers: `/+page.svelte`, `/ticket/+page.svelte`, `/staff/+page.svelte`
 * (mirror onState into the store; reset to `"none"` on unmount).
 * `/issue/+page.svelte` and `/recover/+page.svelte` reset to `"none"`
 * on mount.
 * Reader: `+layout.svelte` (header chip; hidden when `"none"`).
 */
export type WsDisplayState = QueueFeedState | "none"

export const wsStatus = writable<WsDisplayState>("none")
