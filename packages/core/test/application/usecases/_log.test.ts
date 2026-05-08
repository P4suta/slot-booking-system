import type { TraceId } from "@booking/core"
import { describe, expect, it } from "vitest"
import { infoPayload } from "../../../src/application/usecases/_log.js"

describe("infoPayload", () => {
  it("emits the canonical envelope with `severity: domain` for use-case ticks", () => {
    const payload = infoPayload("MarkServed", "I_USECASE_MARK_SERVED", { ticketId: "tkt_x" })
    expect(payload).toEqual({
      _tag: "MarkServed",
      code: "I_USECASE_MARK_SERVED",
      severity: "domain",
      data: { ticketId: "tkt_x" },
    })
  })

  it("includes the traceId field when supplied", () => {
    const traceId = "01HZZZZZZZZZZZZZZZZZZZZZZZ" as TraceId
    const payload = infoPayload("CallNext", "I_USECASE_CALL_NEXT", { seq: 1 }, traceId)
    expect(payload.traceId).toBe(traceId)
    expect(payload.data).toEqual({ seq: 1 })
  })

  it("omits the traceId field when undefined (default behaviour)", () => {
    const payload = infoPayload("CallNext", "I_USECASE_CALL_NEXT", {})
    expect(payload).not.toHaveProperty("traceId")
  })
})
