import { afterEach, describe, expect, it, vi } from "vitest"
import { __setDevLogPublisher, emitStructuredLog } from "../../../src/server/obs/devLogTap.js"

/**
 * Pin the dev-log relay seam (S22b cont. / ADR-0091).
 *
 * `emitStructuredLog` must:
 *   1. invoke the matching `console.{level}` sink so the worker's
 *      native log channel (used by production deploys) still
 *      receives the JSON line, even when the dev relay is wired;
 *   2. forward a `DevLogEntry` to the registered publisher when
 *      `__setDevLogPublisher` has been called (= the worker root
 *      is in dev mode);
 *   3. silently no-op the relay when the publisher is unset
 *      (= production path).
 */

describe("devLogTap", () => {
  afterEach(() => {
    __setDevLogPublisher(null)
    vi.restoreAllMocks()
  })

  it("routes info / warn / error through the matching console sink", () => {
    const info = vi.spyOn(console, "info").mockReturnValue(undefined)
    const warn = vi.spyOn(console, "warn").mockReturnValue(undefined)
    const error = vi.spyOn(console, "error").mockReturnValue(undefined)

    emitStructuredLog("info", '{"_tag":"X","code":"I"}')
    emitStructuredLog("warn", '{"_tag":"Y","code":"W"}')
    emitStructuredLog("error", '{"_tag":"Z","code":"E"}')

    expect(info).toHaveBeenCalledExactlyOnceWith('{"_tag":"X","code":"I"}')
    expect(warn).toHaveBeenCalledExactlyOnceWith('{"_tag":"Y","code":"W"}')
    expect(error).toHaveBeenCalledExactlyOnceWith('{"_tag":"Z","code":"E"}')
  })

  it("forwards a DevLogEntry to the publisher when registered", () => {
    vi.spyOn(console, "warn").mockReturnValue(undefined)
    const captured: unknown[] = []
    __setDevLogPublisher((entry) => {
      captured.push(entry)
    })

    emitStructuredLog("warn", '{"_tag":"HttpEnvelope"}')

    expect(captured).toHaveLength(1)
    const entry = captured[0] as { level: string; emittedAt: number; line: string }
    expect(entry.level).toBe("warn")
    expect(entry.line).toBe('{"_tag":"HttpEnvelope"}')
    expect(typeof entry.emittedAt).toBe("number")
    expect(entry.emittedAt).toBeGreaterThan(0)
  })

  it("is a no-op for the relay when the publisher is unset (prod path)", () => {
    vi.spyOn(console, "info").mockReturnValue(undefined)
    // No __setDevLogPublisher call — the publisher slot stays null.
    expect(() => {
      emitStructuredLog("info", '{"_tag":"HttpRequest"}')
    }).not.toThrow()
  })

  it("clears the publisher when __setDevLogPublisher(null) is called", () => {
    vi.spyOn(console, "warn").mockReturnValue(undefined)
    const captured: unknown[] = []
    __setDevLogPublisher((entry) => {
      captured.push(entry)
    })
    emitStructuredLog("warn", '{"line":1}')
    __setDevLogPublisher(null)
    emitStructuredLog("warn", '{"line":2}')

    expect(captured).toHaveLength(1)
  })
})
