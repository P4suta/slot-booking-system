/**
 * Looping called-chime controller (ADR-0081). The customer-side
 * called-alert (ADR-0072) used to fire a single 500 ms two-tone
 * chime — easy to miss, and gave no help to a customer who walked
 * away from the phone. This controller upgrades the audio playback
 * layer to a **looping 1.5 s, 5-tone pattern** that keeps repeating
 * until the customer taps the on-screen "確認しました" button, the
 * 15 s hard timeout fires, or the page observes a terminal state.
 *
 * The dedup layer in `calledAlert.ts` (localStorage key
 * `(calledAt, nudgeCount)`) is unchanged: a Nudge re-fire calls
 * `start()` again, which transparently swaps the underlying
 * AudioContext and timers while keeping the on-screen ack button
 * visible (no flicker).
 *
 * Module-level state instead of a Svelte 5 rune store: the web
 * app's vitest config runs `environment: "node"` with no svelte
 * preprocessor wired in (see `apps/web/vitest.config.ts`), so a
 * `.svelte.ts` file would crash at import time. The page mirrors
 * `isPlaying()` into a `$state` via `subscribe()`.
 */

type Listener = (playing: boolean) => void

const CYCLE_MS = 2_000
const CHIME_TIMEOUT_MS = 15_000

type Running = {
  ctx: AudioContext
  cycleTimer: ReturnType<typeof setTimeout>
  endTimer: ReturnType<typeof setTimeout>
}

let running: Running | null = null
let playing = false
const listeners = new Set<Listener>()

const notify = (next: boolean): void => {
  for (const fn of listeners) fn(next)
}

const audioCtor = (): typeof AudioContext | undefined => {
  if (typeof window === "undefined") return undefined
  const w = window as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  return w.AudioContext ?? w.webkitAudioContext
}

/**
 * Schedule one 1.5 s chime cycle on the given AudioContext:
 * four short 880 Hz pulses (~150 ms each, 50 ms gap) followed by
 * a longer 1318 Hz tone (~600 ms). Five oscillators per cycle.
 */
const playCycle = (ctx: AudioContext): void => {
  const peak = 0.25
  const playTone = (freq: number, startAt: number, durationMs: number): void => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = "sine"
    o.frequency.value = freq
    o.connect(g)
    g.connect(ctx.destination)
    const startTime = ctx.currentTime + startAt
    const endTime = startTime + durationMs / 1000
    g.gain.setValueAtTime(0, startTime)
    g.gain.linearRampToValueAtTime(peak, startTime + 0.02)
    g.gain.linearRampToValueAtTime(0, endTime)
    o.start(startTime)
    o.stop(endTime)
  }
  playTone(880, 0.0, 150)
  playTone(880, 0.2, 150)
  playTone(880, 0.4, 150)
  playTone(880, 0.6, 150)
  playTone(1318, 0.9, 600)
}

/**
 * Tear down the active AudioContext + timers without touching the
 * `playing` flag. Used both by `stop()` (to fully halt) and by
 * `start()` (when called while already running) to swap internals
 * without dropping the ack button — preventing the flicker that
 * a `playing = false → true` transition would cause.
 */
const teardownRunning = (): void => {
  if (running === null) return
  clearTimeout(running.cycleTimer)
  clearTimeout(running.endTimer)
  // AudioContext.close() is async but we don't need to await — any
  // already-scheduled oscillators are cancelled by close() and we
  // are dropping our reference regardless.
  void running.ctx.close().catch(() => {
    /* close on an already-closed ctx throws on some browsers */
  })
  running = null
}

const stop = (): void => {
  teardownRunning()
  if (!playing) return
  playing = false
  notify(false)
}

const start = (): void => {
  const AudioCtor = audioCtor()
  if (AudioCtor === undefined) {
    // SSR or browser without Web Audio — vibrate / Notification API
    // still fire in calledAlert.ts; nothing to do here.
    return
  }
  // Restart path: tear down internals, but keep `playing = true` so
  // the ack button stays mounted (no flicker).
  teardownRunning()
  const ctx = new AudioCtor()
  // Autoplay policy may keep the ctx in `suspended` state until the
  // next user gesture. We attempt resume and continue regardless —
  // the loop runs silently on locked contexts but the ack button
  // still works (and showNotification / vibrate fire from the
  // caller).
  ctx.resume().catch(() => {
    /* locked by autoplay policy — silent fallback */
  })
  const tick = (): void => {
    if (running === null) return
    playCycle(running.ctx)
    running.cycleTimer = setTimeout(tick, CYCLE_MS)
  }
  playCycle(ctx)
  const cycleTimer = setTimeout(tick, CYCLE_MS)
  const endTimer = setTimeout(stop, CHIME_TIMEOUT_MS)
  running = { ctx, cycleTimer, endTimer }
  if (!playing) {
    playing = true
    notify(true)
  }
}

export const chimeController = {
  start,
  stop,
  isPlaying: (): boolean => playing,
  subscribe: (fn: Listener): (() => void) => {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}
