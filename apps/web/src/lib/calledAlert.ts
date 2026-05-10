/**
 * Customer-side "called" alert (Stage 7 of the slot-booking sprint).
 * Fires three foreground signals — chime, vibrate, browser
 * notification — the moment the WS-driven `/ticket` refresh observes
 * the customer's ticket transitioning into `Called`.
 *
 * Background push (Service Worker + Web Push + VAPID) is deliberately
 * out of scope; that work joins the next sprint's PWA package.
 *
 * Replay protection: each `Called` event carries a fresh `calledAt`
 * Instant. The helper writes the last-notified `calledAt` into
 * `localStorage.queue.lastNotifiedCalledAt` so a tab reload while
 * the ticket is still in `Called` does not re-fire (the customer
 * already heard / saw the call). A staff `Recall → re-Call` cycle
 * mints a new `calledAt`, so the second call does fire.
 */

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

/**
 * Two-tone chime synthesised with the Web Audio API — no asset
 * dependency. A5 (880Hz) → E6 (1318Hz), 220ms per tone with a
 * smoothed amplitude envelope to avoid the click that a hard
 * gate would emit. Returns the AudioContext closure so the caller
 * can decide when to release the resource (we close after the
 * second tone finishes).
 */
const playChime = (): void => {
  if (typeof window === "undefined") return
  // window.AudioContext is non-nullable in lib.dom.d.ts, but at
  // runtime older / restricted browsers (private mode, some
  // embedded webviews) leave it undefined. Cast through unknown
  // so eslint's "no-unnecessary-condition" doesn't trip on the
  // defensive ??.
  const w = window as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  const AudioCtor = w.AudioContext ?? w.webkitAudioContext
  if (AudioCtor === undefined) return
  const ctx = new AudioCtor()
  // Browsers gate AudioContext on a user-gesture; we attempt
  // resume() and continue regardless — chime stays silent on
  // locked contexts but the rest of the alert (vibrate / notify)
  // still fires. Fire-and-forget so the chime tones schedule
  // immediately, not after a resume round-trip.
  ctx.resume().catch(() => {
    /* locked by autoplay policy — silent fallback */
  })
  const playTone = (freq: number, startAt: number, durationMs: number): void => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = "sine"
    o.frequency.value = freq
    o.connect(g)
    g.connect(ctx.destination)
    const peak = 0.25
    const startTime = ctx.currentTime + startAt
    const endTime = startTime + durationMs / 1000
    g.gain.setValueAtTime(0, startTime)
    g.gain.linearRampToValueAtTime(peak, startTime + 0.02)
    g.gain.linearRampToValueAtTime(0, endTime)
    o.start(startTime)
    o.stop(endTime)
  }
  playTone(880, 0, 220)
  playTone(1318, 0.24, 260)
  // 0.5s total + tail.
  setTimeout(() => void ctx.close(), 800)
}

const vibratePattern = (): void => {
  if (typeof navigator === "undefined") return
  if (!("vibrate" in navigator)) return
  navigator.vibrate([300, 120, 300])
}

const showNotification = (displaySeq: number): void => {
  const N = notificationOnWindow()
  if (N === null) return
  if (N.permission !== "granted") return
  const title = "呼ばれました"
  const body = `${String(displaySeq)} 番の方、 受付までお越しください`
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
 * Trigger the alert *iff* this is a fresh Called event (= the
 * `calledAt` instant differs from the last-notified one). No-op
 * when state is not Called, when calledAt is unchanged, or when
 * SSR.
 */
export const maybeTriggerCalledAlert = (input: {
  readonly state: string
  readonly calledAt: string | null | undefined
  readonly displaySeq: number
}): void => {
  if (input.state !== "Called") return
  const calledAt = input.calledAt
  if (calledAt === null || calledAt === undefined) return
  const last = readLastNotifiedAt()
  if (last === calledAt) return
  writeLastNotifiedAt(calledAt)
  playChime()
  vibratePattern()
  showNotification(input.displaySeq)
}
