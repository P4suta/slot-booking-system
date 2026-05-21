import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * pushSubscribe.ts contract — ADR-0073 / ADR-0074. Each branch of
 * `subscribeToPush` and `unsubscribeFromPush` is exercised with the
 * smallest stub set that still drives the production code path
 * (no real `navigator.serviceWorker`, no `fetch`).
 */

const registerSpy = vi.fn()
const unregisterSpy = vi.fn()

vi.mock("../../src/lib/api.js", () => ({
  registerPushSubscription: (...args: unknown[]): unknown => registerSpy(...args) as unknown,
  unregisterPushSubscription: (...args: unknown[]): unknown => unregisterSpy(...args) as unknown,
}))

import { subscribeToPush, unsubscribeFromPush } from "../../src/lib/pushSubscribe.js"

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

type FakeSubscription = {
  endpoint: string
  toJSON: () => Record<string, unknown>
  getKey: (name: string) => ArrayBuffer | null
  unsubscribe: () => Promise<boolean>
}

const makeSubscription = (overrides: Partial<FakeSubscription> = {}): FakeSubscription => {
  const endpoint = overrides.endpoint ?? "https://fcm.googleapis.com/wp/AAA"
  return {
    endpoint,
    toJSON: () => ({
      endpoint,
      keys: { p256dh: "PUB", auth: "AUTH" },
    }),
    getKey: (name) =>
      name === "p256dh" || name === "auth" ? new Uint8Array([1, 2, 3]).buffer : null,
    unsubscribe: () => Promise.resolve(true),
    ...overrides,
  }
}

type StubWindow = {
  localStorage: Storage
  PushManager?: unknown
  Notification?: unknown
}

const installEnv = (params: {
  hasWindow?: boolean
  hasServiceWorker?: boolean
  hasPushManager?: boolean
  hasNotification?: boolean
  notificationPermission?: NotificationPermission
  requestPermissionResult?: NotificationPermission
  existingSubscription?: FakeSubscription | null
  subscribeResult?: FakeSubscription
}) => {
  if (params.hasWindow === false) {
    vi.stubGlobal("window", undefined)
    return { register: vi.fn(), subscribe: vi.fn(), getSubscription: vi.fn() }
  }
  const win: StubWindow = { localStorage: makeStorage() }
  if (params.hasPushManager !== false) win.PushManager = {}
  if (params.hasNotification !== false) {
    const Notif = {
      permission: params.notificationPermission ?? "granted",
      requestPermission: () =>
        Promise.resolve<NotificationPermission>(params.requestPermissionResult ?? "granted"),
    }
    win.Notification = Notif
    vi.stubGlobal("Notification", Notif)
  } else {
    vi.stubGlobal("Notification", undefined)
  }
  vi.stubGlobal("window", win)
  const register = vi.fn()
  const subscribe = vi.fn().mockResolvedValue(params.subscribeResult ?? makeSubscription())
  const getSubscription = vi.fn().mockResolvedValue(params.existingSubscription ?? null)
  const registration = {
    pushManager: { subscribe, getSubscription },
  }
  register.mockResolvedValue(registration)
  const getRegistration = vi.fn().mockResolvedValue(registration)
  if (params.hasServiceWorker !== false) {
    Object.defineProperty(globalThis.navigator, "serviceWorker", {
      configurable: true,
      get: () => ({
        register,
        ready: Promise.resolve(registration),
        getRegistration,
      }),
    })
  } else {
    // `"serviceWorker" in navigator` must evaluate to false — deleting
    // the property is the only way (a getter that returns undefined
    // would still leave the key on the prototype chain).
    delete (globalThis.navigator as unknown as { serviceWorker?: unknown }).serviceWorker
  }
  return { register, subscribe, getSubscription, getRegistration }
}

const VAPID = "BPSAMPLE"
const HANDLE = { nameKana: "ヤマダ", phoneLast4: "1234" }
const TICKET = "01TICKET"

beforeEach(() => {
  registerSpy.mockReset().mockResolvedValue({ ok: true })
  unregisterSpy.mockReset().mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  // Restore navigator.serviceWorker so other tests start clean.
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    configurable: true,
    get: () => undefined,
  })
})

describe("subscribeToPush — short-circuit branches", () => {
  it("returns unsupported when window is undefined (SSR)", async () => {
    installEnv({ hasWindow: false })
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
    })
    expect(result.kind).toBe("unsupported")
    expect(registerSpy).not.toHaveBeenCalled()
  })

  it("returns unsupported when serviceWorker is missing", async () => {
    installEnv({ hasServiceWorker: false })
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
    })
    expect(result.kind).toBe("unsupported")
  })

  it("returns unsupported when PushManager is missing", async () => {
    installEnv({ hasPushManager: false })
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
    })
    expect(result.kind).toBe("unsupported")
  })

  it("returns unsupported when Notification is missing", async () => {
    installEnv({ hasNotification: false })
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
    })
    expect(result.kind).toBe("unsupported")
  })

  it("returns noHandle when handle is null (URL-direct entry / cache wiped)", async () => {
    installEnv({})
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: null,
      vapidPublicKey: VAPID,
    })
    expect(result.kind).toBe("noHandle")
    expect(registerSpy).not.toHaveBeenCalled()
  })

  it("returns permissionDenied when user denies after prompt", async () => {
    installEnv({
      notificationPermission: "default",
      requestPermissionResult: "denied",
    })
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
    })
    expect(result.kind).toBe("permissionDenied")
  })

  it("returns aborted when the signal fires before serviceWorker.register", async () => {
    installEnv({})
    const ac = new AbortController()
    ac.abort()
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
      signal: ac.signal,
    })
    expect(result.kind).toBe("aborted")
  })
})

describe("subscribeToPush — happy paths", () => {
  it("registers a fresh subscription and stores the endpoint for reconcile", async () => {
    const { subscribe } = installEnv({})
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
    })
    expect(result.kind).toBe("subscribed")
    expect(subscribe).toHaveBeenCalledOnce()
    expect(registerSpy).toHaveBeenCalledOnce()
    const stored = (window as unknown as { localStorage: Storage }).localStorage.getItem(
      "queue.lastSubscribedEndpoint",
    )
    expect(stored).toBe("https://fcm.googleapis.com/wp/AAA")
  })

  it("reuses an existing pushManager.getSubscription() without calling subscribe", async () => {
    const existing = makeSubscription({ endpoint: "https://fcm.googleapis.com/wp/EXISTING" })
    const { subscribe } = installEnv({ existingSubscription: existing })
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
    })
    expect(result.kind).toBe("subscribed")
    if (result.kind === "subscribed") {
      expect(result.endpoint).toBe("https://fcm.googleapis.com/wp/EXISTING")
    }
    expect(subscribe).not.toHaveBeenCalled()
  })

  it("reconciles a rotated endpoint: DELETE the stale row before registering the fresh one", async () => {
    installEnv({})
    ;(window as unknown as { localStorage: Storage }).localStorage.setItem(
      "queue.lastSubscribedEndpoint",
      "https://fcm.googleapis.com/wp/OLD",
    )
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
    })
    expect(result.kind).toBe("subscribed")
    expect(unregisterSpy).toHaveBeenCalledOnce()
    expect(unregisterSpy.mock.calls[0]).toEqual([
      TICKET,
      HANDLE,
      "https://fcm.googleapis.com/wp/OLD",
    ])
    expect(registerSpy).toHaveBeenCalledOnce()
  })

  it("skips reconcile when the stored endpoint matches the current one", async () => {
    installEnv({})
    ;(window as unknown as { localStorage: Storage }).localStorage.setItem(
      "queue.lastSubscribedEndpoint",
      "https://fcm.googleapis.com/wp/AAA",
    )
    await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
    })
    expect(unregisterSpy).not.toHaveBeenCalled()
  })
})

describe("subscribeToPush — error paths", () => {
  it("returns error when the browser cannot produce encryption keys", async () => {
    const sub = makeSubscription({ getKey: () => null })
    installEnv({ existingSubscription: sub })
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
    })
    expect(result.kind).toBe("error")
  })

  it("returns error when registerPushSubscription fails", async () => {
    installEnv({})
    registerSpy.mockResolvedValueOnce({
      ok: false,
      kind: "DomainError",
      status: 409,
      error: { _tag: "PhoneMismatch", code: "E_DOM_PHONE_MISMATCH" },
      traceId: null,
    })
    const result = await subscribeToPush({
      ticketId: TICKET,
      handle: HANDLE,
      vapidPublicKey: VAPID,
    })
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.reason).toMatch(/PhoneMismatch/)
    }
  })
})

describe("unsubscribeFromPush", () => {
  it("is a no-op when window is undefined (SSR)", async () => {
    installEnv({ hasWindow: false })
    await unsubscribeFromPush(TICKET, HANDLE)
    expect(unregisterSpy).not.toHaveBeenCalled()
  })

  it("is a no-op when no serviceWorker registration exists", async () => {
    installEnv({})
    // Override getRegistration to return undefined.
    Object.defineProperty(globalThis.navigator, "serviceWorker", {
      configurable: true,
      get: () => ({ getRegistration: () => Promise.resolve(undefined) }),
    })
    await unsubscribeFromPush(TICKET, HANDLE)
    expect(unregisterSpy).not.toHaveBeenCalled()
  })

  it("calls subscription.unsubscribe() + server DELETE on the happy path", async () => {
    const unsubSpy = vi.fn().mockResolvedValue(true)
    const sub = makeSubscription({ unsubscribe: unsubSpy })
    installEnv({ existingSubscription: sub })
    await unsubscribeFromPush(TICKET, HANDLE)
    expect(unsubSpy).toHaveBeenCalledOnce()
    expect(unregisterSpy).toHaveBeenCalledOnce()
  })

  it("clears the stored lastSubscribedEndpoint on unsubscribe", async () => {
    installEnv({ existingSubscription: makeSubscription() })
    ;(window as unknown as { localStorage: Storage }).localStorage.setItem(
      "queue.lastSubscribedEndpoint",
      "https://fcm.googleapis.com/wp/AAA",
    )
    await unsubscribeFromPush(TICKET, HANDLE)
    const after = (window as unknown as { localStorage: Storage }).localStorage.getItem(
      "queue.lastSubscribedEndpoint",
    )
    expect(after).toBeNull()
  })

  it("skips server DELETE when handle is null but still calls subscription.unsubscribe()", async () => {
    const unsubSpy = vi.fn().mockResolvedValue(true)
    installEnv({ existingSubscription: makeSubscription({ unsubscribe: unsubSpy }) })
    await unsubscribeFromPush(TICKET, null)
    expect(unsubSpy).toHaveBeenCalledOnce()
    expect(unregisterSpy).not.toHaveBeenCalled()
  })
})
