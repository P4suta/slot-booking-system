import { describe, expect, it } from "vitest"
import {
  fromLegacy,
  initialState,
  label,
  type QueueFeedState,
  tone,
  transition,
} from "../src/lib/queueFeedMachine.js"

describe("queueFeedMachine — Moore machine for the WS feed", () => {
  describe("transition", () => {
    it("ws_open lands on `open` regardless of prior state", () => {
      const prevs: QueueFeedState[] = [
        { tag: "connecting", attempt: 0 },
        { tag: "reconnecting", attempt: 3, retryAt: 1000 },
        { tag: "closed", reason: "client-done" },
      ]
      for (const prev of prevs) {
        const next = transition(prev, { type: "ws_open", at: 100 })
        expect(next.tag).toBe("open")
        if (next.tag === "open") expect(next.openedAt).toBe(100)
      }
    })

    it("ws_close lands on `closed` carrying the reason", () => {
      const next = transition(initialState, { type: "ws_close", reason: "1006-abnormal" })
      expect(next).toEqual({ tag: "closed", reason: "1006-abnormal" })
    })

    it("ws_reconnect lands on `reconnecting` with attempt + retryAt", () => {
      const next = transition(
        { tag: "open", openedAt: 100 },
        {
          type: "ws_reconnect",
          attempt: 2,
          retryAt: 200,
        },
      )
      expect(next).toEqual({ tag: "reconnecting", attempt: 2, retryAt: 200 })
    })

    it("manual_close lands on `closed` with client-done reason", () => {
      const next = transition({ tag: "open", openedAt: 100 }, { type: "manual_close" })
      expect(next).toEqual({ tag: "closed", reason: "client-done" })
    })
  })

  describe("label (Moore output)", () => {
    it("connecting with attempt=0 renders 接続中", () => {
      expect(label({ tag: "connecting", attempt: 0 })).toBe("接続中...")
    })
    it("connecting with attempt>0 renders 再接続中 with count", () => {
      expect(label({ tag: "connecting", attempt: 3 })).toContain("3")
    })
    it("open renders 接続中", () => {
      expect(label({ tag: "open", openedAt: 0 })).toBe("接続中")
    })
    it("reconnecting renders 再接続中 with attempt", () => {
      expect(label({ tag: "reconnecting", attempt: 5, retryAt: 0 })).toContain("5")
    })
    it("closed renders 切断", () => {
      expect(label({ tag: "closed", reason: "x" })).toBe("切断")
    })
  })

  describe("tone (Moore output)", () => {
    it("open → green", () => {
      expect(tone({ tag: "open", openedAt: 0 })).toBe("green")
    })
    it("connecting → yellow", () => {
      expect(tone({ tag: "connecting", attempt: 0 })).toBe("yellow")
    })
    it("reconnecting → yellow", () => {
      expect(tone({ tag: "reconnecting", attempt: 1, retryAt: 0 })).toBe("yellow")
    })
    it("closed → red", () => {
      expect(tone({ tag: "closed", reason: "x" })).toBe("red")
    })
  })

  describe("fromLegacy", () => {
    it("undefined → connecting (fresh start)", () => {
      expect(fromLegacy(undefined).tag).toBe("connecting")
    })
    it("'connecting' → connecting", () => {
      expect(fromLegacy("connecting").tag).toBe("connecting")
    })
    it("'open' → open", () => {
      expect(fromLegacy("open").tag).toBe("open")
    })
    it("'reconnecting' → reconnecting", () => {
      expect(fromLegacy("reconnecting").tag).toBe("reconnecting")
    })
    it("'closed' → closed", () => {
      expect(fromLegacy("closed").tag).toBe("closed")
    })
  })

  it("initialState is connecting(attempt=0)", () => {
    expect(initialState).toEqual({ tag: "connecting", attempt: 0 })
  })
})
