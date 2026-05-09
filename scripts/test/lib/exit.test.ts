import { describe, expect, it } from "vitest"
import { classifyExit } from "./exit.js"

const base = {
  filter: "@booking/core",
  passed: 0,
  failed: 0,
  runnerErr: 0,
  code: 0 as number | null,
  signal: null as NodeJS.Signals | null,
}

describe("classifyExit", () => {
  it("returns 0 with no note when vitest exited cleanly", () => {
    expect(classifyExit({ ...base, code: 0, passed: 5 })).toEqual({ exit: 0 })
  })

  it("returns 1 when at least one test failed (regardless of exit code)", () => {
    const decision = classifyExit({ ...base, code: 0, passed: 5, failed: 1 })
    expect(decision.exit).toBe(1)
    expect(decision.note).toContain("@booking/core")
    expect(decision.note).toContain("1 failed")
  })

  it("returns 1 when a RunnerError surfaced even with no failed cases", () => {
    const decision = classifyExit({ ...base, code: 0, passed: 5, runnerErr: 2 })
    expect(decision.exit).toBe(1)
    expect(decision.note).toContain("2 runner-error")
  })

  it("absorbs the SIGTERM teardown hang when at least one test passed", () => {
    const decision = classifyExit({
      ...base,
      code: null,
      signal: "SIGTERM",
      passed: 34,
    })
    expect(decision.exit).toBe(0)
    expect(decision.note).toContain("runner hung after 34 ✓")
  })

  it("absorbs the 124 timeout exit code when at least one test passed", () => {
    const decision = classifyExit({ ...base, code: 124, passed: 12 })
    expect(decision.exit).toBe(0)
    expect(decision.note).toContain("treating timeout as success")
  })

  it("propagates a timeout exit when no test had passed yet", () => {
    const decision = classifyExit({
      ...base,
      code: null,
      signal: "SIGKILL",
      passed: 0,
    })
    // No passed cases — the timeout is not safe to absorb. We do
    // not have a numeric exit code in this case, so the runner
    // falls back to the default `1`.
    expect(decision.exit).toBe(1)
    expect(decision.note).toContain("vitest exited")
  })

  it("propagates a non-zero, non-timeout exit code verbatim", () => {
    const decision = classifyExit({ ...base, code: 7, passed: 3 })
    expect(decision.exit).toBe(7)
    expect(decision.note).toContain("vitest exited 7")
  })
})
