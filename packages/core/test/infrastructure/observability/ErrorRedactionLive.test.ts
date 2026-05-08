import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { ErrorRedaction } from "../../../src/application/ports/ErrorRedaction.js"
import { RuntimeMode } from "../../../src/application/ports/RuntimeMode.js"
import {
  devRedactCause,
  ErrorRedactionLive,
  prodRedactCause,
} from "../../../src/infrastructure/observability/ErrorRedactionLive.js"

/**
 * Pin the env-indexed error-cause redactor (ADR-0043). Three axes:
 *
 *   1. `devRedactCause` — surfaces `name` / `message` / capped stack
 *      preview / `originalTag` (when the error carries a `_tag`
 *      static).
 *   2. `prodRedactCause` — terminal object on the wire surface
 *      (always `{}`).
 *   3. `ErrorRedactionLive` — the env-indexed `Layer` selects the
 *      right redactor from the resolved {@link RuntimeMode}.
 *
 * The cap (`STACK_FRAME_PREVIEW = 4`) is tested by feeding a 10-line
 * stack and asserting only the first four lines reappear — the
 * defence against accidentally publishing deep async stacks.
 */

describe("devRedactCause (commit 15)", () => {
  it("projects an Error onto {name, message, stack[0..3]}", () => {
    const err = new Error("boom")
    err.stack = ["frame-0", "frame-1", "frame-2", "frame-3", "frame-4", "frame-5"].join("\n")
    const out = devRedactCause(err)
    expect(out).toMatchObject({
      name: "Error",
      message: "boom",
      stack: "frame-0\nframe-1\nframe-2\nframe-3",
    })
  })

  it("includes originalTag when the Error carries a string `_tag` static", () => {
    const err = Object.assign(new Error("auth failed"), { _tag: "InvalidPhoneLast4" })
    const out = devRedactCause(err)
    expect(out).toMatchObject({
      name: "Error",
      message: "auth failed",
      originalTag: "InvalidPhoneLast4",
    })
  })

  it("omits originalTag when `_tag` is absent or non-string", () => {
    expect(devRedactCause(new Error("no-tag"))).not.toHaveProperty("originalTag")
    expect(devRedactCause(Object.assign(new Error(), { _tag: 42 }))).not.toHaveProperty(
      "originalTag",
    )
  })

  it("omits stack when the underlying Error has no stack", () => {
    const err = new Error("stackless")
    delete err.stack
    const out = devRedactCause(err)
    expect(out).not.toHaveProperty("stack")
  })

  it("falls back to {value: String(cause)} for non-Error inputs", () => {
    expect(devRedactCause("a string")).toEqual({ value: "a string" })
    expect(devRedactCause(42)).toEqual({ value: "42" })
    expect(devRedactCause(null)).toEqual({ value: "null" })
    expect(devRedactCause(undefined)).toEqual({ value: "undefined" })
  })

  it("caps stack output at four frames regardless of input length", () => {
    const err = new Error("cap")
    err.stack = Array.from({ length: 50 }, (_, i) => `frame-${String(i)}`).join("\n")
    const out = devRedactCause(err) as { readonly stack: string }
    expect(out.stack.split("\n")).toHaveLength(4)
  })
})

describe("prodRedactCause (commit 15)", () => {
  it("returns the empty object for any input (terminal redactor)", () => {
    expect(prodRedactCause(new Error("never"))).toEqual({})
    expect(prodRedactCause("ignored")).toEqual({})
    expect(prodRedactCause(undefined)).toEqual({})
  })
})

describe("ErrorRedactionLive (commit 15)", () => {
  const runWith = async (mode: "dev" | "prod"): Promise<Record<string, unknown>> => {
    const program = Effect.gen(function* () {
      const r = yield* ErrorRedaction
      return r.redact(new Error("probe"))
    })
    const layer = ErrorRedactionLive.pipe(
      Layer.provide(Layer.succeed(RuntimeMode, RuntimeMode.of({ mode }))),
    )
    return Effect.runPromise(program.pipe(Effect.provide(layer)))
  }

  it("dev-mode redactor yields the {name, message, …} preview", async () => {
    expect(await runWith("dev")).toMatchObject({ name: "Error", message: "probe" })
  })

  it("prod-mode redactor yields the empty terminal object", async () => {
    expect(await runWith("prod")).toEqual({})
  })
})
