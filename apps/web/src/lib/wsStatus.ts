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
 * Writers: `/+page.svelte`, `/ticket/+page.svelte`, `/staff/+page.svelte`.
 * Reader: `+layout.svelte` (header chip).
 *
 * The default `connecting` is what every fresh tab observes before
 * the first `onState` callback fires, so the chip never starts on a
 * misleading "open" or "closed".
 */
export const wsStatus = writable<QueueFeedState>("connecting")
