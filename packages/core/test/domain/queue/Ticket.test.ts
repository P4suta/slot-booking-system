import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  isTerminal,
  TERMINAL_TICKET_STATES,
  type Ticket,
  TicketSchema,
} from "../../../src/domain/queue/Ticket.js"
import { newTicketId } from "../../../src/domain/types/EntityId.js"

const decodeOrThrow = (raw: unknown): Ticket => {
  const r = Schema.decodeUnknownResult(TicketSchema)(raw)
  if (Result.isSuccess(r)) return r.success
  throw new Error(`decode failed: ${String(r.failure)}`)
}

const baseFields = {
  id: newTicketId(),
  seq: 1,
  lane: "walkIn",
  displaySeq: 1,
  nameKana: "ヤマダ タロウ",
  phoneLast4: "1234",
  freeText: null,
  issuedAt: "2026-05-08T09:00:00Z",
  appointmentAt: null,
  checkedInAt: null,
}

describe("TicketSchema discrimination", () => {
  it.each([
    ["Waiting", { ...baseFields, state: "Waiting" }],
    [
      "Called",
      {
        ...baseFields,
        state: "Called",
        calledAt: "2026-05-08T09:05:00Z",
        calledBy: "staff",
      },
    ],
    [
      "Served",
      {
        ...baseFields,
        state: "Served",
        calledAt: "2026-05-08T09:05:00Z",
        calledBy: "staff",
        servedAt: "2026-05-08T09:10:00Z",
        servedBy: "staff",
      },
    ],
    [
      "NoShow",
      {
        ...baseFields,
        state: "NoShow",
        calledAt: "2026-05-08T09:05:00Z",
        calledBy: "staff",
        markedAt: "2026-05-08T09:10:00Z",
        markedBy: "staff",
      },
    ],
    [
      "Cancelled",
      {
        ...baseFields,
        state: "Cancelled",
        cancelledAt: "2026-05-08T09:05:00Z",
        cancelledBy: "customer",
        reason: "changed plans",
      },
    ],
  ])("decodes a %s ticket", (label, raw) => {
    const t = decodeOrThrow(raw)
    expect(t.state).toBe(label)
  })

  it("rejects an unknown state", () => {
    const r = Schema.decodeUnknownResult(TicketSchema)({ ...baseFields, state: "Unknown" })
    expect(Result.isFailure(r)).toBe(true)
  })

  it.each(["walkIn", "priority", "reservation"])("decodes a %s lane", (lane) => {
    const t = decodeOrThrow({ ...baseFields, lane, state: "Waiting" })
    expect(t.lane).toBe(lane)
  })

  it("rejects an unknown lane", () => {
    const r = Schema.decodeUnknownResult(TicketSchema)({
      ...baseFields,
      lane: "vip",
      state: "Waiting",
    })
    expect(Result.isFailure(r)).toBe(true)
  })
})

describe("TERMINAL_TICKET_STATES / isTerminal", () => {
  it("lists Served / NoShow / Cancelled", () => {
    expect(TERMINAL_TICKET_STATES).toEqual(["Served", "NoShow", "Cancelled"])
  })

  it("isTerminal returns true for the three terminal variants", () => {
    expect(
      isTerminal(
        decodeOrThrow({
          ...baseFields,
          state: "Cancelled",
          cancelledAt: "2026-05-08T09:00:00Z",
          cancelledBy: "customer",
          reason: "x",
        }),
      ),
    ).toBe(true)
    expect(
      isTerminal(
        decodeOrThrow({
          ...baseFields,
          state: "Served",
          calledAt: "2026-05-08T09:00:00Z",
          calledBy: "staff",
          servedAt: "2026-05-08T09:00:00Z",
          servedBy: "staff",
        }),
      ),
    ).toBe(true)
    expect(
      isTerminal(
        decodeOrThrow({
          ...baseFields,
          state: "NoShow",
          calledAt: "2026-05-08T09:00:00Z",
          calledBy: "staff",
          markedAt: "2026-05-08T09:00:00Z",
          markedBy: "system",
        }),
      ),
    ).toBe(true)
  })

  it("isTerminal returns false for Waiting / Called (both active)", () => {
    expect(isTerminal(decodeOrThrow({ ...baseFields, state: "Waiting" }))).toBe(false)
    expect(
      isTerminal(
        decodeOrThrow({
          ...baseFields,
          state: "Called",
          calledAt: "2026-05-08T09:00:00Z",
          calledBy: "staff",
        }),
      ),
    ).toBe(false)
  })
})
