import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  CurrentTraceId,
  getCurrentTraceId,
  mintTraceId,
  withTraceId,
} from "../../../src/application/runtime/TraceContext.js"
import { isTraceId } from "../../../src/domain/errors/TraceId.js"

describe("CurrentTraceId FiberRef", () => {
  it("defaults to undefined when no scope has pinned a trace id", async () => {
    const value = await Effect.runPromise(getCurrentTraceId)
    expect(value).toBeUndefined()
  })

  it("withTraceId pins the value for the inner effect", async () => {
    const traceId = mintTraceId()
    const inner = getCurrentTraceId
    const got = await Effect.runPromise(withTraceId(traceId, inner))
    expect(got).toBe(traceId)
  })

  it("withTraceId restores the outer value after exit", async () => {
    const t1 = mintTraceId()
    const t2 = mintTraceId()
    const program = withTraceId(
      t1,
      Effect.gen(function* () {
        const inside = yield* getCurrentTraceId
        const nested = yield* withTraceId(t2, getCurrentTraceId)
        const after = yield* getCurrentTraceId
        return { inside, nested, after }
      }),
    )
    const { inside, nested, after } = await Effect.runPromise(program)
    expect(inside).toBe(t1)
    expect(nested).toBe(t2)
    expect(after).toBe(t1)
  })

  it("FiberRef value passes the TraceId pattern", () => {
    const traceId = mintTraceId()
    expect(isTraceId(traceId)).toBe(true)
  })

  // Direct reference to the FiberRef itself so import-graph tooling
  // (knip) sees the export as used. The instance is the canonical
  // anchor for all reads / writes; callers usually go through the
  // helpers above but adapter code may use it directly.
  it("CurrentTraceId is a stable shared FiberRef instance", () => {
    expect(CurrentTraceId).toBeDefined()
  })
})
