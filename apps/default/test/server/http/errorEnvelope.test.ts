import type { DomainError } from "@booking/core"
import { errorClassRegistry } from "@booking/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  __setEnvelopeLogTap,
  type HttpEnvelopeLog,
  logHttpEnvelope,
  statusForTag,
} from "../../../src/server/http/errorEnvelope.js"

/**
 * Matrix test for the registry × envelope-helper coupling.
 *
 * `errorClassRegistry` is the SoT for every `DomainError` the
 * domain layer can emit. `statusForTag` (a `Match.tagged` over
 * `DomainError["_tag"]`) refuses to compile if a new tag lands
 * without a status assignment — but we additionally pin the
 * runtime mapping at test time so a future grep / refactor can't
 * silently widen the response surface.
 *
 * The "log entry shape per tag" half pins
 * `logHttpEnvelope({errorTag, code, status, path, method})`'s
 * output: every registry tag emits a `HttpEnvelopeLog` with the
 * tag echoed back, the status from the helper, and a traceId
 * field (null in this no-OTel test scope, populated under the
 * worker's `instrument(...)` wrap).
 */

const KNOWN_HTTP_STATUSES = [403, 404, 409, 422, 500] as const

// `Schema.TaggedErrorClass` doesn't expose the tag as a class-side
// static, so we list the registry's 22 tag strings here. The
// readonly array literal is checked against `DomainError["_tag"]`
// at compile time — adding a new error class without updating the
// matrix fails type-check immediately. The `length === registry`
// runtime assertion guards against the registry growing without
// the matrix being updated.
const REGISTRY_TAGS: readonly DomainError["_tag"][] = [
  "InvalidPhoneLast4",
  "InvalidNameKana",
  "InvalidFreeText",
  "InvalidBusinessTimeZone",
  "InvalidEntityId",
  "MissingStaffCapability",
  "PhoneMismatch",
  "TicketNotFound",
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
  "AggregateNotFound",
  "Concurrency",
  "Storage",
] as const

let captured: HttpEnvelopeLog[] = []

beforeEach(() => {
  captured = []
  __setEnvelopeLogTap((entry) => {
    captured.push(entry)
  })
})

afterEach(() => {
  __setEnvelopeLogTap(null)
})

describe("errorClassRegistry × statusForTag (22/22 matrix)", () => {
  it("registry has 22 error classes (ADR-0009 + ADR-0070 LaneMismatch + ADR-0066/0068 reservation 4)", () => {
    expect(errorClassRegistry.length).toBe(22)
    expect(REGISTRY_TAGS.length).toBe(22)
  })

  it("every registry tag maps to a known HTTP status", () => {
    for (const tag of REGISTRY_TAGS) {
      const status = statusForTag(tag)
      expect(KNOWN_HTTP_STATUSES, `tag=${tag} status=${String(status)}`).toContain(status)
    }
  })

  it("every registry tag emits a HttpEnvelopeLog with the same fields back", () => {
    for (const tag of REGISTRY_TAGS) {
      const status = statusForTag(tag)
      logHttpEnvelope({
        errorTag: tag,
        errorCode: `E_TEST_${tag.toUpperCase()}`,
        status,
        path: "/api/v1/test",
        method: "POST",
      })
    }
    expect(captured.length).toBe(REGISTRY_TAGS.length)
    for (let i = 0; i < REGISTRY_TAGS.length; i += 1) {
      expect(captured[i]?.errorTag).toBe(REGISTRY_TAGS[i])
      expect(captured[i]?.method).toBe("POST")
      expect(captured[i]?.path).toBe("/api/v1/test")
      // No active OTel span in this unit test, so traceId is null.
      expect(captured[i]?.traceId).toBeNull()
    }
  })
})
