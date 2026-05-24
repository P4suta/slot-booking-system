/**
 * Customer-side "called" / Overdue-nudge alert (ADR-0072).
 * Fires three foreground signals — chime, vibrate, browser
 * notification — the moment the WS-driven `/ticket` refresh observes
 * the customer's ticket transitioning into `Called` *or* receiving a
 * fresh `Nudged` event in `Overdue`.
 *
 * Background push (Service Worker + Web Push + VAPID) is the
 * companion transport (ADR-0073) and lands separately.
 *
 * Replay protection: the dedup key is `(calledAt, nudgeCount)`. Each
 * `Called` event carries a fresh `calledAt` and an implicit
 * `nudgeCount = 0`; each `Nudged` event increments `nudgeCount`.
 * A staff `Recall → re-Call` cycle mints a new `calledAt`, so the
 * second call also fires.
 *
 * Audio playback was upgraded from a single 500 ms two-tone chime
 * to a 15 s loop of a 1.5 s five-tone pattern (ADR-0081); the loop
 * lives in `chimeController` so the `/ticket` page can render an
 * acknowledge button and stop the chime mid-loop. This file owns
 * the dedup + vibrate + Notification signals only.
 */

import { chimeController } from "./chimeController.js"
import { m } from "./messages.js"

const STORAGE_KEY = "queue.lastNotifiedCalledAt"

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported"

type NotificationCtor = typeof Notification

const notificationOnWindow = (): NotificationCtor | null => {
  if (typeof window === "undefined") return null
  const N = (window as unknown as { Notification?: NotificationCtor }).Notification
  return N ?? null
}

export const notificationPermissionState = (): NotificationPermissionState => {
  const N = notificationOnWindow()
  if (N === null) return "unsupported"
  return N.permission
}

export const requestNotificationPermission = async (): Promise<NotificationPermissionState> => {
  const N = notificationOnWindow()
  if (N === null) return "unsupported"
  if (N.permission !== "default") return N.permission
  return await N.requestPermission()
}

const vibratePattern = (): void => {
  if (typeof navigator === "undefined") return
  if (!("vibrate" in navigator)) return
  navigator.vibrate([300, 120, 300])
}

const showNotification = (displaySeq: number, kind: "called" | "overdue"): void => {
  const N = notificationOnWindow()
  if (N === null) return
  if (N.permission !== "granted") return
  // Phase A3 — Notification copy goes through paraglide so the
  // catalogue parity test (`test/i18n/paraglide-keys.test.ts`)
  // pins the JA / EN pair, and no inline strings linger on the
  // wire-side of the boundary ([[feedback-ui-copy-in-paraglide]]).
  const displaySeqStr = String(displaySeq)
  const title = kind === "called" ? m.notification_called_title() : m.notification_overdue_title()
  const body =
    kind === "called"
      ? m.notification_called_body({ displaySeq: displaySeqStr })
      : m.notification_overdue_body({ displaySeq: displaySeqStr })
  try {
    const n = new N(title, {
      body,
      // SvelteKit places `app.html`'s favicon at /favicon.png; the
      // Notification API silently no-ops when icon is missing.
      icon: "/favicon.png",
      tag: "queue-called",
    })
    // Auto-dismiss after 15s so the OS-level notification does not
    // linger when the customer has already acted on it.
    setTimeout(() => {
      n.close()
    }, 15_000)
  } catch {
    /* notification creation can throw on some browsers if the page
       is not fully active; the chime + vibrate already fired so
       the customer has the primary signal. */
  }
}

const readLastNotifiedAt = (): string | null => {
  if (typeof window === "undefined") return null
  return window.localStorage.getItem(STORAGE_KEY)
}

const writeLastNotifiedAt = (at: string): void => {
  if (typeof window === "undefined") return
  window.localStorage.setItem(STORAGE_KEY, at)
}

/**
 * Clear the alert memory. Called when the cache is purged
 * (terminal state, by-handle 404) so a fresh issue with the same
 * device starts with a clean notification slate.
 */
export const clearAlertMemory = (): void => {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(STORAGE_KEY)
}

/**
 * Trigger the alert *iff* this is a fresh `(calledAt, nudgeCount)`
 * tuple. No-op when state is not Called/Overdue, when calledAt is
 * unchanged AND nudgeCount is unchanged, or when SSR.
 */
export const maybeTriggerCalledAlert = (input: {
  readonly state: string
  readonly calledAt: string | null | undefined
  readonly nudgeCount?: number
  readonly displaySeq: number
}): void => {
  if (input.state !== "Called" && input.state !== "Overdue") return
  const calledAt = input.calledAt
  if (calledAt === null || calledAt === undefined) return
  const nudgeCount = input.nudgeCount ?? 0
  // Dedup key joins both axes (ADR-0072). A Called→Overdue transition
  // with nudgeCount=0 carries the same calledAt as the original Called
  // event, so we do not fire twice on the auto-promotion; only the
  // subsequent Nudged events (which set nudgeCount=1, 2, 3) re-fire.
  const key = `${calledAt}#${String(nudgeCount)}`
  const last = readLastNotifiedAt()
  if (last === key) return
  writeLastNotifiedAt(key)
  chimeController.start()
  vibratePattern()
  showNotification(input.displaySeq, input.state === "Called" ? "called" : "overdue")
}
