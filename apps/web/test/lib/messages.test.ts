import { describe, expect, it } from "vitest"
import {
  type EmptyContext,
  emptyState,
  errorMessage,
  type HelpContext,
  helpText,
  type LoadingContext,
  loadingState,
} from "../../src/lib/messages.js"

const KNOWN_ERROR_TAGS = [
  // Validation
  "InvalidPhoneLast4",
  "InvalidNameKana",
  "InvalidFreeText",
  "InvalidBusinessTimeZone",
  "InvalidEntityId",
  "InvalidLane",
  "InvalidBody",
  "InvalidPayload",
  "MissingStaffCapability",
  // Domain
  "TicketNotFound",
  "PhoneMismatch",
  "QueueEmpty",
  "AlreadyCancelled",
  "AlreadyCompleted",
  "AlreadyNoShow",
  "InvalidStateTransition",
  "InsufficientCapability",
  "LaneMismatch",
  "SlotFull",
  "SlotInPast",
  "AppointmentRequiredForReservationLane",
  "CheckInTooEarly",
  // Infrastructure
  "AggregateNotFound",
  "Concurrency",
  "Storage",
  // Boundary / network
  "RateLimited",
  "NetworkError",
  "InvalidEnvelope",
] as const

describe("messages.ts — paraglide-backed copy lookup", () => {
  describe("errorMessage", () => {
    it.each(KNOWN_ERROR_TAGS)("returns a non-empty Japanese fallback for %s", (tag) => {
      const text = errorMessage(tag)
      expect(typeof text).toBe("string")
      expect(text.length).toBeGreaterThan(0)
      // The default locale is Japanese (paraglide baseLocale=ja); a
      // smoke check that we didn't accidentally fall through to the
      // raw key name (paraglide returns `error_<Tag>` if no
      // translation is registered).
      expect(text).not.toBe(`error_${tag}`)
    })

    it("falls back to error_unknown for an unrecognised tag", () => {
      const text = errorMessage("ZorpNotFound")
      expect(text).toMatch(/想定外|unknown|unexpected/i)
    })

    it("falls back even when the tag string is empty", () => {
      const text = errorMessage("")
      expect(typeof text).toBe("string")
      expect(text.length).toBeGreaterThan(0)
    })
  })

  describe("emptyState", () => {
    const contexts: readonly EmptyContext[] = [
      "calling",
      "overdue",
      "waiting",
      "terminal",
      "byHandle404",
      "slotPicker",
    ]

    it.each(contexts)("yields a non-empty string for %s", (ctx) => {
      const text = emptyState(ctx)
      expect(typeof text).toBe("string")
      expect(text.length).toBeGreaterThan(0)
    })
  })

  describe("loadingState", () => {
    const contexts: readonly LoadingContext[] = ["ticket", "revalidate", "reschedule", "slots"]

    it.each(contexts)("yields a non-empty string for %s", (ctx) => {
      const text = loadingState(ctx)
      expect(typeof text).toBe("string")
      expect(text.length).toBeGreaterThan(0)
    })
  })

  describe("helpText", () => {
    const contexts: readonly HelpContext[] = [
      "reschedule",
      "recoverHandle",
      "notifyPermission",
      "slotPicker",
    ]

    it.each(contexts)("yields a non-empty string for %s", (ctx) => {
      const text = helpText(ctx)
      expect(typeof text).toBe("string")
      expect(text.length).toBeGreaterThan(0)
    })
  })
})
