// Service Worker for Web Push (ADR-0073 / ADR-0074).
//
// The page (`/ticket`) registers this worker on first mount after
// the customer grants Notification permission. The worker handles
// two events:
//
//   - `push` — a payload arrived from the push service. We parse
//     the JSON, render a Notification, and discard the data. We do
//     NOT navigate anywhere on receipt; the customer reopens
//     `/ticket` themselves so the page rehydrates from /api/v1.
//
//   - `notificationclick` — when the customer taps the
//     notification, focus an open `/ticket` tab if there is one,
//     otherwise open one.
//
// ADR-0074 keeps the payload PII-free: only `displaySeq` + a short
// `kind` enum reach this worker.

const VALID_KINDS = new Set(["called", "overdue", "overdue-1", "overdue-2", "overdue-final"])

const titleFor = (kind) => {
  if (kind === "called") return "呼ばれました"
  return "応答をお願いします"
}

const bodyFor = (kind, displaySeq) => {
  const seq = typeof displaySeq === "number" ? String(displaySeq) : ""
  if (kind === "called") return `${seq} 番の方、 受付までお越しください`
  return `${seq} 番の方、 ご応答をお願いします`
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      // M3: parse strictly. A malformed or empty payload should NOT
      // produce a fabricated "応答をお願いします" notification — the
      // customer would not understand what changed. Silently skip;
      // the open-tab WebSocket fallback still handles state changes.
      if (event.data === null) return
      let parsed = null
      try {
        parsed = await event.data.json()
      } catch {
        return
      }
      if (parsed === null || typeof parsed !== "object") return
      if (!VALID_KINDS.has(parsed.kind)) return
      const displaySeq = typeof parsed.displaySeq === "number" ? parsed.displaySeq : undefined
      await self.registration.showNotification(titleFor(parsed.kind), {
        body: bodyFor(parsed.kind, displaySeq),
        tag: `queue-${parsed.kind}`,
        renotify: true,
        // No icon path — keeps the SW free of asset references that
        // would 404 in deployments that have not shipped them.
      })
    })(),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      // M2: includeUncontrolled would pull in windows owned by other
      // service-worker registrations (a PWA on the same origin) and
      // potentially focus the wrong app. Restrict to windows this
      // SW controls.
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: false })
      for (const c of all) {
        if (c.url.includes("/ticket")) {
          await c.focus()
          return
        }
      }
      await self.clients.openWindow("/ticket")
    })(),
  )
})

// RFC 8030 §7.3 — push services may rotate subscription keys and
// fire `subscriptionchange` to let the SW re-register. When that
// happens we cannot reach the back-end ourselves (the SW has no
// stored `(ticketId, handle)` — that PII lives only in the page's
// localStorage), so we post a message to every open `/ticket` tab
// so the page can trigger the re-register flow on the next event
// loop. For closed tabs, the next time the page mounts the
// `pushSubscribe.ts` reconcile path will compare
// `pushManager.getSubscription().endpoint` against
// `localStorage["queue.lastSubscribedEndpoint"]` and DELETE-then-
// register if they diverged.
self.addEventListener("subscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const oldEndpoint = event.oldSubscription?.endpoint ?? null
      const newEndpoint = event.newSubscription?.endpoint ?? null
      const clientsList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: false,
      })
      for (const c of clientsList) {
        c.postMessage({ type: "push:resubscribe", oldEndpoint, newEndpoint })
      }
    })(),
  )
})

// `install` and `activate` use the default lifecycle — no caching
// needed; the SW is here purely for push delivery.
