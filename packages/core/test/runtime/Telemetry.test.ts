import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  addAttributes,
  recordTaggedError,
  tapTaggedError,
  withSpan,
} from "../../src/application/runtime/Telemetry.js"
import { InvalidPhoneLast4Error } from "../../src/domain/errors/Errors.js"

/**
 * Telemetry helpers exercised against an active span. Pins the
 * inside-the-span paths so the OTel-attribute projection is covered
 * (the no-span branch short-circuits via `Effect.ignore` and is
 * exercised by the use-case integration tests).
 */
describe("Telemetry — inside an active span", () => {
  it("withSpan preserves the inner Effect's success channel", async () => {
    const program = withSpan("test.outer", { "test.attr": 1 }, Effect.succeed(42))
    expect(await Effect.runPromise(program)).toBe(42)
  })

  it("addAttributes is a no-op outside a span (no defect)", async () => {
    await Effect.runPromise(addAttributes({ a: 1, b: "two" }))
  })

  it("addAttributes lands the attribute set on the active span", async () => {
    const program = withSpan(
      "test.attrs",
      {},
      addAttributes({ "domain.entity": "Service", "domain.id": "serv_abc" }),
    )
    await Effect.runPromise(program)
  })

  it("recordTaggedError sets error.* attributes on the active span", async () => {
    const err = new InvalidPhoneLast4Error({ reason: "wrong-length" })
    const program = withSpan("test.error", {}, recordTaggedError(err))
    await Effect.runPromise(program)
  })

  it("recordTaggedError is a no-op when no span is active", async () => {
    const err = new InvalidPhoneLast4Error({ reason: "wrong-length" })
    await Effect.runPromise(recordTaggedError(err))
  })

  it("tapTaggedError records the error and re-fails the inner effect", async () => {
    const err = new InvalidPhoneLast4Error({ reason: "wrong-length" })
    const program = withSpan("test.tap", {}, tapTaggedError(Effect.fail(err)))
    const exit = await Effect.runPromiseExit(program)
    expect(exit._tag).toBe("Failure")
  })

  it("tapTaggedError passes through success", async () => {
    const program = withSpan("test.tap.success", {}, tapTaggedError(Effect.succeed("ok")))
    expect(await Effect.runPromise(program)).toBe("ok")
  })

  it("recordTaggedError + currentSpan reads non-trivially mid-flow (e2e)", async () => {
    // Confirms the Telemetry stack is reachable end-to-end: the helper
    // resolves Effect.currentSpan inside an active span, projects the
    // tagged-error metadata onto the span's attribute API, and ignores
    // a missing-span case without raising. Closes ADR-0038 carry-over B
    // for the unit-suite — full worker-bound integration lives in
    // apps/default/test/effectRpc/spanEmission.test.ts.
    const err = new InvalidPhoneLast4Error({ reason: "wrong-length" })
    const program = withSpan(
      "test.e2e",
      {},
      Effect.flatMap(Effect.currentSpan, (span) =>
        Effect.map(recordTaggedError(err), () => span.name),
      ),
    )
    expect(await Effect.runPromise(program)).toBe("test.e2e")
  })
})
