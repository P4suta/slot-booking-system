import { base64UrlToBytes, bytesToBase64Url } from "@booking/push"
import { registerPushSubscription, unregisterPushSubscription } from "./api.js"

/**
 * Customer-side Web Push subscription helper (ADR-0073). The flow:
 *
 *   1. Confirm the browser supports `serviceWorker` + `PushManager`.
 *   2. Confirm (or request) Notification permission.
 *   3. Register `/sw.js`.
 *   4. Reuse the existing PushSubscription if present, else
 *      `pushManager.subscribe({applicationServerKey})`.
 *   5. POST the subscription to the back-end.
 *
 * The whole flow is best-effort — anything that fails (unsupported
 * browser, denied permission, push service down) silently degrades
 * to the WebSocket nudge fallback path. No telemetry, no PII.
 *
 * The base64url codec is shared with `@booking/push` (server-side
 * encryption pipeline) so a fix to one side covers both.
 */

const arrayBufferToBase64Url = (buffer: ArrayBuffer | null): string =>
  buffer === null ? "" : bytesToBase64Url(new Uint8Array(buffer))

/**
 * ADR-0073 reconcile path — track the last endpoint we successfully
 * registered with the server. A `subscriptionchange` event (or a
 * silent browser rotation we did not observe) makes
 * `pushManager.getSubscription().endpoint` diverge from this value;
 * the next `subscribeToPush` call DELETE-then-registers so the
 * server stops sending pushes to the dead endpoint.
 */
const LAST_ENDPOINT_KEY = "queue.lastSubscribedEndpoint"

const readLastEndpoint = (): string | null => {
  if (typeof window === "undefined") return null
  return window.localStorage.getItem(LAST_ENDPOINT_KEY)
}

const writeLastEndpoint = (endpoint: string): void => {
  if (typeof window === "undefined") return
  window.localStorage.setItem(LAST_ENDPOINT_KEY, endpoint)
}

const clearLastEndpoint = (): void => {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(LAST_ENDPOINT_KEY)
}

export type SubscribeResult =
  | { readonly kind: "subscribed"; readonly endpoint: string }
  | { readonly kind: "permissionDenied" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "noHandle" }
  | { readonly kind: "aborted" }
  | { readonly kind: "error"; readonly reason: string }

const checkAborted = (signal?: AbortSignal): SubscribeResult | null =>
  signal?.aborted === true ? { kind: "aborted" } : null

export const subscribeToPush = async (params: {
  readonly ticketId: string
  readonly handle: { readonly nameKana: string; readonly phoneLast4: string } | null
  readonly vapidPublicKey: string
  readonly signal?: AbortSignal
}): Promise<SubscribeResult> => {
  if (typeof window === "undefined") return { kind: "unsupported" }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { kind: "unsupported" }
  }
  if (typeof Notification === "undefined") return { kind: "unsupported" }
  // ADR-0074: backend requires `(nameKana, phoneLast4)` to register a
  // subscription. Without it (URL-direct entry, other device, cache
  // wiped) we silently degrade to the WS-only path.
  if (params.handle === null) return { kind: "noHandle" }

  let permission = Notification.permission
  if (permission === "default") {
    permission = await Notification.requestPermission()
  }
  if (permission !== "granted") return { kind: "permissionDenied" }
  const aborted = checkAborted(params.signal)
  if (aborted !== null) return aborted

  try {
    const registration = await navigator.serviceWorker.register("/sw.js")
    await navigator.serviceWorker.ready
    const a1 = checkAborted(params.signal)
    if (a1 !== null) return a1
    let subscription = await registration.pushManager.getSubscription()
    if (subscription === null) {
      // TS 6's tightened `Uint8Array<ArrayBufferLike>` does not satisfy
      // `BufferSource` (which expects `ArrayBufferView<ArrayBuffer>`).
      // The bytes returned by `base64UrlToBytes` are private (built via
      // `new Uint8Array(n)`), so the cast is safe.
      const appServerKey = base64UrlToBytes(params.vapidPublicKey)
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey as unknown as BufferSource,
      })
    }
    const a2 = checkAborted(params.signal)
    if (a2 !== null) return a2
    const json = subscription.toJSON() as {
      readonly endpoint?: string
      readonly keys?: { readonly p256dh?: string; readonly auth?: string }
    }
    const endpoint = json.endpoint ?? subscription.endpoint
    // Reconcile: if the browser silently rotated the subscription
    // (RFC 8030 §7.3) the endpoint we hold differs from the one the
    // server last saw. Drop the stale row before registering the
    // fresh endpoint so the server stops attempting deliveries that
    // would 410 anyway.
    const lastEndpoint = readLastEndpoint()
    if (lastEndpoint !== null && lastEndpoint !== endpoint) {
      await unregisterPushSubscription(params.ticketId, params.handle, lastEndpoint)
    }
    const p256dhRaw = subscription.getKey("p256dh")
    const authRaw = subscription.getKey("auth")
    if (p256dhRaw === null || authRaw === null) {
      return { kind: "error", reason: "browser did not provide encryption keys" }
    }
    const p256dh = json.keys?.p256dh ?? arrayBufferToBase64Url(p256dhRaw)
    const auth = json.keys?.auth ?? arrayBufferToBase64Url(authRaw)
    if (endpoint === "" || p256dh === "" || auth === "") {
      return { kind: "error", reason: "missing subscription fields" }
    }
    const result = await registerPushSubscription(params.ticketId, {
      nameKana: params.handle.nameKana,
      phoneLast4: params.handle.phoneLast4,
      endpoint,
      p256dh,
      auth,
    })
    if (!result.ok) {
      return { kind: "error", reason: `register: ${result.error._tag}` }
    }
    writeLastEndpoint(endpoint)
    return { kind: "subscribed", endpoint }
  } catch (err) {
    return { kind: "error", reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Tear down a previously-registered Web Push subscription. Called
 * when the customer's ticket reaches a terminal state on the
 * client side (defensive — the server reaps the row too) or when
 * the customer explicitly disables notifications.
 *
 * Order: `subscription.unsubscribe()` runs **first** so the browser
 * stops carrying a live subscription, then the server `DELETE` is
 * best-effort. If the server call fails the row is reaped on the
 * next alarm sweep when the push service responds 410 to the
 * subsequent send attempt.
 */
export const unsubscribeFromPush = async (
  ticketId: string,
  handle: { readonly nameKana: string; readonly phoneLast4: string } | null,
): Promise<void> => {
  if (typeof window === "undefined") return
  if (!("serviceWorker" in navigator)) return
  try {
    const registration = await navigator.serviceWorker.getRegistration("/sw.js")
    if (registration === undefined) return
    const subscription = await registration.pushManager.getSubscription()
    if (subscription === null) return
    const endpoint = subscription.endpoint
    // Client-side unsubscribe first — fail-fast on the local side so a
    // server outage cannot leave the browser holding a live
    // subscription that would keep waking up.
    try {
      await subscription.unsubscribe()
    } catch {
      /* unsubscribe failed locally — server row is still reachable via 410 sweep */
    }
    if (handle !== null) {
      // Server delete best-effort; 410 sweep is the safety net.
      await unregisterPushSubscription(ticketId, handle, endpoint)
    }
    clearLastEndpoint()
  } catch {
    /* best-effort */
  }
}
