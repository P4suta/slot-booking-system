/**
 * `QueueFeedState` Moore machine (S19 / ADR-0087).
 *
 * The WebSocket projection feed sits in one of four states at
 * any moment; this module pins those states and the legal
 * transitions in a single transition table so the page-level
 * connection indicator reads off a typed value instead of a
 * `string | undefined` flag.
 *
 * Moore semantics: the *output* (display label + colour token)
 * is a function of the current state alone, not of the event
 * that produced it. The page renders by `derive(label, state)`
 * — no mid-transition flicker, no extra `lastEvent` boolean.
 */

export type QueueFeedState =
  | { readonly tag: "connecting"; readonly attempt: number }
  | { readonly tag: "open"; readonly openedAt: number }
  | { readonly tag: "reconnecting"; readonly attempt: number; readonly retryAt: number }
  | { readonly tag: "closed"; readonly reason: string }

export type QueueFeedEvent =
  | { readonly type: "ws_open"; readonly at: number }
  | { readonly type: "ws_close"; readonly reason: string }
  | { readonly type: "ws_reconnect"; readonly attempt: number; readonly retryAt: number }
  | { readonly type: "manual_close" }

/** Total transition function — no silent ignores. */
export const transition = (_prev: QueueFeedState, event: QueueFeedEvent): QueueFeedState => {
  switch (event.type) {
    case "ws_open":
      return { tag: "open", openedAt: event.at }
    case "ws_close":
      return { tag: "closed", reason: event.reason }
    case "ws_reconnect":
      return { tag: "reconnecting", attempt: event.attempt, retryAt: event.retryAt }
    case "manual_close":
      return { tag: "closed", reason: "client-done" }
  }
}

/** Moore output — display label for the connection indicator. */
export const label = (state: QueueFeedState): string => {
  switch (state.tag) {
    case "connecting":
      return state.attempt === 0 ? "接続中..." : `再接続中... (${String(state.attempt)})`
    case "open":
      return "接続中"
    case "reconnecting":
      return `再接続中... (${String(state.attempt)})`
    case "closed":
      return "切断"
  }
}

/** Moore output — semantic colour token (`@tailwind` class root). */
export const tone = (state: QueueFeedState): "green" | "yellow" | "red" => {
  switch (state.tag) {
    case "open":
      return "green"
    case "connecting":
    case "reconnecting":
      return "yellow"
    case "closed":
      return "red"
  }
}

/** Map the legacy `wsStatus` string into a typed machine state. */
export const fromLegacy = (
  legacy: "connecting" | "open" | "reconnecting" | "closed" | undefined,
): QueueFeedState => {
  switch (legacy) {
    case undefined:
    case "connecting":
      return { tag: "connecting", attempt: 0 }
    case "open":
      return { tag: "open", openedAt: Date.now() }
    case "reconnecting":
      return { tag: "reconnecting", attempt: 1, retryAt: Date.now() + 1000 }
    case "closed":
      return { tag: "closed", reason: "client-done" }
  }
}

export const initialState: QueueFeedState = { tag: "connecting", attempt: 0 }
