import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearAlertMemory,
  maybeTriggerCalledAlert,
  notificationPermissionState,
  requestNotificationPermission,
} from "../src/lib/calledAlert.js"
import { chimeController } from "../src/lib/chimeController.js"

/**
 * Called-alert helper contract (Stage 7 of the slot-booking
 * sprint). The unit exercises the replay-protection invariant
 * (one alert per calledAt), the no-op paths (state != Called,
 * calledAt missing), and the notification-permission state
 * mapping. Web Audio + vibrate + Notification side-effects are
 * stubbed.
 */

const makeStorage = (): Storage => {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => {
      data.clear()
    },
    getItem: (k) => data.get(k) ?? null,
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => {
      data.delete(k)
    },
    setItem: (k, v) => {
      data.set(k, v)
    },
  }
}

type StubWindow = {
  localStorage: Storage
  sessionStorage: Storage
  AudioContext?: unknown
  Notification?: unknown
}

const winStub = (): StubWindow => ({
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
})

const noop = (): void => undefined

const stubAudio = (): { plays: number } => {
  const tracker = { plays: 0 }
  const fake = {
    currentTime: 0,
    destination: {},
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
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
  }
  const w = window as unknown as StubWindow
  // Constructor stub via Proxy — biome forbids `return` from a
  // class constructor, and a class with a stored backing field
  // would require Object.assign'ing every fake-method onto `this`.
  // A Proxy whose `construct` returns `fake` is the smallest
  // change that makes `new AudioCtor()` yield the right shape.
  function FakeAudioContext(): void {
    // The constructor is intercepted by the proxy's `construct`
    // trap, so the function body never executes — biome's
    // no-empty-function check requires the comment to be the
    // body, which it accepts.
    return
  }
  w.AudioContext = new Proxy(FakeAudioContext, {
    construct: () => fake,
  })
  return tracker
}

const stubVibrate = (): { calls: number[][] } => {
  const tracker = { calls: [] as number[][] }
  ;(globalThis.navigator as unknown as { vibrate?: (p: number[]) => void }).vibrate = (pattern) => {
    tracker.calls.push(pattern)
  }
  return tracker
}

const stubNotification = (permission: NotificationPermission): { ctor: number } => {
  const tracker = { ctor: 0 }
  function NotificationStub(this: unknown) {
    tracker.ctor += 1
    return this
  }
  ;(NotificationStub as unknown as { permission: NotificationPermission }).permission = permission
  ;(
    NotificationStub as unknown as { requestPermission: () => Promise<NotificationPermission> }
  ).requestPermission = () => Promise.resolve("granted")
  const w = window as unknown as StubWindow
  w.Notification = NotificationStub
  return tracker
}

beforeEach(() => {
  vi.stubGlobal("window", winStub())
  delete (globalThis.navigator as unknown as { vibrate?: unknown }).vibrate
  // ADR-0081: the chime is now a looping 15 s effect — without fake
  // timers the setTimeouts would leak across tests and the singleton
  // would still be playing when the next test reads `audio.plays`.
  vi.useFakeTimers()
})

afterEach(() => {
  // Stop the controller before tearing down the stubbed window so
  // its `ctx.close()` runs against the still-alive fake AudioContext.
  chimeController.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("ADR-0069 Stage 7 — called alert", () => {
  it("fires on the first Called observation, persists calledAt", () => {
    const audio = stubAudio()
    const vibrate = stubVibrate()
    const notif = stubNotification("granted")
    maybeTriggerCalledAlert({
      state: "Called",
      calledAt: "2026-05-11T10:00:00.000Z",
      displaySeq: 42,
    })
    // ADR-0081: one cycle of the looping chime fires 5 oscillators
    // (4 short 880 Hz pulses + 1 long 1318 Hz tone).
    expect(audio.plays).toBe(5)
    expect(vibrate.calls).toHaveLength(1)
    expect(vibrate.calls[0]).toEqual([300, 120, 300])
    expect(notif.ctor).toBe(1)
    const w = window as unknown as { localStorage: Storage }
    // ADR-0072: dedup key is `${calledAt}#${nudgeCount}` so each Nudged
    // event can fire once. A bare Called event implies nudgeCount=0.
    expect(w.localStorage.getItem("queue.lastNotifiedCalledAt")).toBe("2026-05-11T10:00:00.000Z#0")
  })

  it("no-op on the same calledAt — survives tab reload while still Called", () => {
    const audio = stubAudio()
    const vibrate = stubVibrate()
    const notif = stubNotification("granted")
    maybeTriggerCalledAlert({
      state: "Called",
      calledAt: "2026-05-11T10:00:00.000Z",
      displaySeq: 42,
    })
    // Same calledAt → no further alerts.
    maybeTriggerCalledAlert({
      state: "Called",
      calledAt: "2026-05-11T10:00:00.000Z",
      displaySeq: 42,
    })
    expect(audio.plays).toBe(5)
    expect(vibrate.calls).toHaveLength(1)
    expect(notif.ctor).toBe(1)
  })

  it("fires again after Recall → re-Call (new calledAt)", () => {
    const audio = stubAudio()
    const vibrate = stubVibrate()
    const notif = stubNotification("granted")
    maybeTriggerCalledAlert({
      state: "Called",
      calledAt: "2026-05-11T10:00:00.000Z",
      displaySeq: 42,
    })
    maybeTriggerCalledAlert({
      state: "Called",
      calledAt: "2026-05-11T10:05:00.000Z",
      displaySeq: 42,
    })
    // Each fire restarts the chime loop → 5 oscillators × 2 fires.
    expect(audio.plays).toBe(10)
    expect(vibrate.calls).toHaveLength(2)
    expect(notif.ctor).toBe(2)
  })

  it("no-op when state is not Called or Overdue", () => {
    const audio = stubAudio()
    const vibrate = stubVibrate()
    const notif = stubNotification("granted")
    maybeTriggerCalledAlert({ state: "Waiting", calledAt: null, displaySeq: 42 })
    // ADR-0071 removed `Serving`; surfaces here as just "any other state".
    maybeTriggerCalledAlert({
      state: "Cancelled",
      calledAt: "2026-05-11T10:00:00.000Z",
      displaySeq: 42,
    })
    maybeTriggerCalledAlert({
      state: "Served",
      calledAt: "2026-05-11T10:00:00.000Z",
      displaySeq: 42,
    })
    expect(audio.plays).toBe(0)
    expect(vibrate.calls).toHaveLength(0)
    expect(notif.ctor).toBe(0)
  })

  it("fires on Overdue with nudgeCount=1, re-fires for each subsequent nudgeCount (ADR-0072)", () => {
    // De-dup key is `(calledAt, nudgeCount)`. The Called→Overdue
    // promotion preserves `calledAt` and resets `nudgeCount` to 0,
    // so the first nudge (count=1) is the first new alert event;
    // subsequent nudges (2, 3) must each re-fire exactly once.
    const audio = stubAudio()
    const vibrate = stubVibrate()
    const notif = stubNotification("granted")
    const baseCalledAt = "2026-05-11T10:00:00.000Z"
    // Called→Overdue with nudgeCount=0 carries the same calledAt as the
    // original Called event — must NOT re-fire (would be a double-chime
    // for the same audio event from the customer's perspective).
    maybeTriggerCalledAlert({ state: "Called", calledAt: baseCalledAt, displaySeq: 42 })
    expect(notif.ctor).toBe(1)
    maybeTriggerCalledAlert({
      state: "Overdue",
      calledAt: baseCalledAt,
      nudgeCount: 0,
      displaySeq: 42,
    })
    expect(notif.ctor).toBe(1)
    // First nudge fires.
    maybeTriggerCalledAlert({
      state: "Overdue",
      calledAt: baseCalledAt,
      nudgeCount: 1,
      displaySeq: 42,
    })
    expect(notif.ctor).toBe(2)
    // Idempotent — same nudgeCount observed twice (WS replay / refresh).
    maybeTriggerCalledAlert({
      state: "Overdue",
      calledAt: baseCalledAt,
      nudgeCount: 1,
      displaySeq: 42,
    })
    expect(notif.ctor).toBe(2)
    // Second nudge fires.
    maybeTriggerCalledAlert({
      state: "Overdue",
      calledAt: baseCalledAt,
      nudgeCount: 2,
      displaySeq: 42,
    })
    expect(notif.ctor).toBe(3)
    // Third nudge fires.
    maybeTriggerCalledAlert({
      state: "Overdue",
      calledAt: baseCalledAt,
      nudgeCount: 3,
      displaySeq: 42,
    })
    expect(notif.ctor).toBe(4)
    expect(audio.plays).toBe(5 * 4) // 5-osc chime cycle × 4 fires (initial Called + 3 nudges)
    expect(vibrate.calls).toHaveLength(4)
    const w = window as unknown as { localStorage: Storage }
    expect(w.localStorage.getItem("queue.lastNotifiedCalledAt")).toBe(`${baseCalledAt}#3`)
  })

  it("no notification call when permission is not granted", () => {
    stubAudio()
    stubVibrate()
    const notif = stubNotification("denied")
    maybeTriggerCalledAlert({
      state: "Called",
      calledAt: "2026-05-11T10:00:00.000Z",
      displaySeq: 42,
    })
    expect(notif.ctor).toBe(0)
  })

  it("notificationPermissionState reads window.Notification.permission", () => {
    expect(notificationPermissionState()).toBe("unsupported")
    stubNotification("granted")
    expect(notificationPermissionState()).toBe("granted")
    stubNotification("denied")
    expect(notificationPermissionState()).toBe("denied")
    stubNotification("default")
    expect(notificationPermissionState()).toBe("default")
  })

  it("requestNotificationPermission proxies to Notification.requestPermission", async () => {
    stubNotification("default")
    const got = await requestNotificationPermission()
    expect(got).toBe("granted")
  })

  it("requestNotificationPermission short-circuits when permission is already decided", async () => {
    stubNotification("granted")
    expect(await requestNotificationPermission()).toBe("granted")
    stubNotification("denied")
    expect(await requestNotificationPermission()).toBe("denied")
  })

  it("clearAlertMemory wipes the persisted calledAt", () => {
    stubAudio()
    stubVibrate()
    stubNotification("granted")
    maybeTriggerCalledAlert({
      state: "Called",
      calledAt: "2026-05-11T10:00:00.000Z",
      displaySeq: 42,
    })
    const w = window as unknown as { localStorage: Storage }
    expect(w.localStorage.getItem("queue.lastNotifiedCalledAt")).not.toBeNull()
    clearAlertMemory()
    expect(w.localStorage.getItem("queue.lastNotifiedCalledAt")).toBeNull()
  })
})
