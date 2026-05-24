import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chimeController } from "../src/lib/chimeController.js"

/**
 * Looping called-chime controller (ADR-0081). The unit exercises:
 *   - One cycle = 5 oscillators.
 *   - Loop continues every 2 s until the 15 s hard timeout fires.
 *   - `stop()` is idempotent and notifies subscribers exactly once.
 *   - `start()` while running swaps the underlying AudioContext but
 *     does NOT toggle `playing` (no ack-button flicker).
 *   - `subscribe()` / unsubscribe lifecycle.
 * AudioContext is stubbed; fake timers drive cycle + timeout
 * transitions.
 */

type FakeCtx = {
  currentTime: number
  destination: object
  resume: () => Promise<void>
  close: () => Promise<void>
  createOscillator: () => unknown
  createGain: () => unknown
}

type AudioTracker = {
  plays: number
  closes: number
  /** ordered list of every ctx created — last is "current". */
  ctxs: FakeCtx[]
}

const noop = (): void => undefined

const stubAudio = (): AudioTracker => {
  const tracker: AudioTracker = { plays: 0, closes: 0, ctxs: [] }
  const makeCtx = (): FakeCtx => ({
    currentTime: 0,
    destination: {},
    resume: () => Promise.resolve(),
    close: () => {
      tracker.closes += 1
      return Promise.resolve()
    },
    createOscillator: () => {
      tracker.plays += 1
      return {
        type: "sine",
        frequency: { value: 0 },
        connect: noop,
        start: noop,
        stop: noop,
      }
    },
    createGain: () => ({
      gain: {
        setValueAtTime: noop,
        linearRampToValueAtTime: noop,
      },
      connect: noop,
    }),
  })
  // biome forbids `return` from a class constructor, so we wrap a
  // plain function in a Proxy whose `construct` trap returns a fresh
  // fake ctx — mirroring the calledAlert test stub pattern.
  function FakeAudioContext(): void {
    return
  }
  ;(window as unknown as { AudioContext: unknown }).AudioContext = new Proxy(FakeAudioContext, {
    construct: () => {
      const ctx = makeCtx()
      tracker.ctxs.push(ctx)
      return ctx
    },
  })
  return tracker
}

beforeEach(() => {
  // vitest runs `environment: "node"`, so `window` is undefined by
  // default. Stub the minimal surface — chimeController only reads
  // `window.AudioContext` / `window.webkitAudioContext`.
  vi.stubGlobal("window", {})
  vi.useFakeTimers()
})

afterEach(() => {
  chimeController.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("ADR-0081 — looping chime controller", () => {
  it("plays 5 oscillators on the first cycle and reports playing=true", () => {
    const audio = stubAudio()
    expect(chimeController.isPlaying()).toBe(false)
    chimeController.start()
    expect(audio.plays).toBe(5)
    expect(chimeController.isPlaying()).toBe(true)
  })

  it("loops every 2 s — second cycle adds another 5 oscillators", () => {
    const audio = stubAudio()
    chimeController.start()
    vi.advanceTimersByTime(2_000)
    expect(audio.plays).toBe(10)
    vi.advanceTimersByTime(2_000)
    expect(audio.plays).toBe(15)
  })

  it("stops automatically after the 15 s hard timeout", () => {
    const audio = stubAudio()
    chimeController.start()
    // 15 s = 7 cycles fire at t=0, 2, 4, 6, 8, 10, 12 → 7 * 5 = 35
    // oscillators before the auto-stop trips at t=15.
    vi.advanceTimersByTime(15_000)
    expect(chimeController.isPlaying()).toBe(false)
    expect(audio.closes).toBe(1)
    const before = audio.plays
    vi.advanceTimersByTime(10_000)
    expect(audio.plays).toBe(before)
  })

  it("stop() closes the active AudioContext and flips playing to false", () => {
    const audio = stubAudio()
    chimeController.start()
    expect(chimeController.isPlaying()).toBe(true)
    chimeController.stop()
    expect(chimeController.isPlaying()).toBe(false)
    expect(audio.closes).toBe(1)
    // No further cycles after stop.
    vi.advanceTimersByTime(10_000)
    expect(audio.plays).toBe(5)
  })

  it("stop() is idempotent", () => {
    const audio = stubAudio()
    chimeController.start()
    chimeController.stop()
    chimeController.stop()
    chimeController.stop()
    expect(audio.closes).toBe(1)
    expect(chimeController.isPlaying()).toBe(false)
  })

  it("stop() before start() is a no-op (no listener notification, no crash)", () => {
    stubAudio()
    const seen: boolean[] = []
    const unsub = chimeController.subscribe((p) => {
      seen.push(p)
    })
    chimeController.stop()
    expect(seen).toEqual([])
    unsub()
  })

  it("start() while running closes the old ctx but keeps playing=true (no flicker)", () => {
    const audio = stubAudio()
    const seen: boolean[] = []
    const unsub = chimeController.subscribe((p) => {
      seen.push(p)
    })
    chimeController.start()
    expect(seen).toEqual([true])
    expect(audio.ctxs).toHaveLength(1)
    chimeController.start()
    expect(audio.ctxs).toHaveLength(2)
    expect(audio.closes).toBe(1) // old ctx closed
    // listeners should NOT receive a redundant `true` (would force
    // the ack-button to re-mount and could be lost during the
    // intermediate render).
    expect(seen).toEqual([true])
    expect(chimeController.isPlaying()).toBe(true)
    unsub()
  })

  it("start() resets the 15 s timeout — second start extends the loop", () => {
    const audio = stubAudio()
    chimeController.start()
    // t=0 fires immediately (5 osc); cycles at t=2,4,6,8,10 add 25
    // → 6 cycles total → 30 oscillators after advancing 10 s.
    vi.advanceTimersByTime(10_000)
    expect(audio.plays).toBe(30)
    chimeController.start() // restart resets endTimer (and ctx)
    const after = audio.plays
    // Original 15 s deadline would have fired at total 15 s; we
    // advance only 10 s more (= 20 s from the very first start) and
    // expect the loop to still be running because the second start
    // gave it a fresh 15 s window.
    vi.advanceTimersByTime(10_000)
    expect(chimeController.isPlaying()).toBe(true)
    expect(audio.plays).toBeGreaterThan(after)
  })

  it("subscribe() notifies once on start and once on stop", () => {
    stubAudio()
    const seen: boolean[] = []
    const unsub = chimeController.subscribe((p) => {
      seen.push(p)
    })
    chimeController.start()
    chimeController.stop()
    expect(seen).toEqual([true, false])
    unsub()
  })

  it("subscribe() unsubscribe handle stops receiving notifications", () => {
    stubAudio()
    const seen: boolean[] = []
    const unsub = chimeController.subscribe((p) => {
      seen.push(p)
    })
    unsub()
    chimeController.start()
    chimeController.stop()
    expect(seen).toEqual([])
  })

  it("start() is a no-op when window.AudioContext is unavailable", () => {
    // Older browsers / private modes — `AudioContext` undefined.
    ;(window as unknown as { AudioContext?: unknown }).AudioContext = undefined
    ;(window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext = undefined
    const seen: boolean[] = []
    const unsub = chimeController.subscribe((p) => {
      seen.push(p)
    })
    chimeController.start()
    expect(chimeController.isPlaying()).toBe(false)
    expect(seen).toEqual([])
    unsub()
  })
})
