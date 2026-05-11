import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearAlertMemory,
  maybeTriggerCalledAlert,
  notificationPermissionState,
  requestNotificationPermission,
} from "../src/lib/calledAlert.js"

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
})

afterEach(() => {
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
    // 2-tone chime → 2 oscillators.
    expect(audio.plays).toBe(2)
    expect(vibrate.calls).toHaveLength(1)
    expect(vibrate.calls[0]).toEqual([300, 120, 300])
    expect(notif.ctor).toBe(1)
    const w = window as unknown as { localStorage: Storage }
    expect(w.localStorage.getItem("queue.lastNotifiedCalledAt")).toBe("2026-05-11T10:00:00.000Z")
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
    expect(audio.plays).toBe(2)
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
    expect(audio.plays).toBe(4)
    expect(vibrate.calls).toHaveLength(2)
    expect(notif.ctor).toBe(2)
  })

  it("no-op when state is not Called", () => {
    const audio = stubAudio()
    const vibrate = stubVibrate()
    const notif = stubNotification("granted")
    maybeTriggerCalledAlert({ state: "Waiting", calledAt: null, displaySeq: 42 })
    maybeTriggerCalledAlert({
      state: "Served",
      calledAt: "2026-05-11T10:00:00.000Z",
      displaySeq: 42,
    })
    expect(audio.plays).toBe(0)
    expect(vibrate.calls).toHaveLength(0)
    expect(notif.ctor).toBe(0)
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
