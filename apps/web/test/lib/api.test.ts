import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { rescheduleTicket } from "../../src/lib/api.js"

type MockFetch = ReturnType<typeof vi.fn>

const okResponse = (payload: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ ok: true, ...payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const errResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

describe("rescheduleTicket", () => {
  let originalFetch: typeof fetch
  let fetchMock: MockFetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const ticketDto = {
    id: "01TICKET",
    state: "Waiting",
    lane: "reservation",
    appointmentAt: "2026-05-12T14:30:00.000Z",
    nameKana: "ヤマダ",
    phoneLast4: "1234",
    seq: 7,
    displaySeq: "G-007",
  }

  it("issues a POST with handle + newAppointmentAt body", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ticket: ticketDto }))

    const result = await rescheduleTicket("01TICKET", {
      nameKana: "ヤマダ",
      phoneLast4: "1234",
      newAppointmentAt: "2026-05-12T14:30:00.000Z",
    })

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    const call = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toMatch(/\/api\/v1\/tickets\/01TICKET\/reschedule$/)
    expect(call[1].method).toBe("POST")
    expect(call[1].headers).toEqual({ "content-type": "application/json" })
    expect(JSON.parse(call[1].body as string)).toEqual({
      nameKana: "ヤマダ",
      phoneLast4: "1234",
      newAppointmentAt: "2026-05-12T14:30:00.000Z",
    })
  })

  it("surfaces 409 SlotFull as a typed ApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      errResponse(409, {
        error: { _tag: "SlotFull", code: "E_DOM_SLOT_FULL", message: "満席" },
      }),
    )

    const result = await rescheduleTicket("01TICKET", {
      nameKana: "ヤマダ",
      phoneLast4: "1234",
      newAppointmentAt: "2026-05-12T14:30:00.000Z",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error._tag).toBe("SlotFull")
    }
  })

  it("surfaces 422 SlotInPast", async () => {
    fetchMock.mockResolvedValueOnce(
      errResponse(422, {
        error: { _tag: "SlotInPast", code: "E_DOM_SLOT_IN_PAST", message: "past" },
      }),
    )

    const result = await rescheduleTicket("01TICKET", {
      nameKana: "ヤマダ",
      phoneLast4: "1234",
      newAppointmentAt: "2020-01-01T00:00:00.000Z",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error._tag).toBe("SlotInPast")
    }
  })

  it("surfaces 403 PhoneMismatch", async () => {
    fetchMock.mockResolvedValueOnce(
      errResponse(403, {
        error: { _tag: "PhoneMismatch", code: "E_DOM_PHONE_MISMATCH", message: "mismatch" },
      }),
    )

    const result = await rescheduleTicket("01TICKET", {
      nameKana: "ヤマダ",
      phoneLast4: "9999",
      newAppointmentAt: "2026-05-12T14:30:00.000Z",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error._tag).toBe("PhoneMismatch")
    }
  })

  it("surfaces 404 TicketNotFound", async () => {
    fetchMock.mockResolvedValueOnce(
      errResponse(404, {
        error: {
          _tag: "TicketNotFound",
          code: "E_DOM_TICKET_NOT_FOUND",
          message: "missing",
        },
      }),
    )

    const result = await rescheduleTicket("01MISSING", {
      nameKana: "ヤマダ",
      phoneLast4: "1234",
      newAppointmentAt: "2026-05-12T14:30:00.000Z",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error._tag).toBe("TicketNotFound")
    }
  })

  it("returns NetworkError when fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"))

    const result = await rescheduleTicket("01TICKET", {
      nameKana: "ヤマダ",
      phoneLast4: "1234",
      newAppointmentAt: "2026-05-12T14:30:00.000Z",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe("NetworkError")
    }
  })
})
