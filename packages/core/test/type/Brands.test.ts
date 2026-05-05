import { expectTypeOf, test } from "vitest"
import type {
  AuditLogId,
  BookingEventId,
  BookingId,
  BusinessHoursId,
  ClosureId,
  IdempotencyKeyId,
  ProviderAbsenceId,
  ProviderId,
  ResourceId,
  ServiceId,
} from "../../src/domain/types/EntityId.js"
import type { BookingCode } from "../../src/domain/value-objects/BookingCode.js"
import type { BusinessTimeZone } from "../../src/domain/value-objects/BusinessTimeZone.js"
import type { Minutes } from "../../src/domain/value-objects/Duration.js"
import type { FreeText } from "../../src/domain/value-objects/FreeText.js"
import type { HoldingDays } from "../../src/domain/value-objects/HoldingDays.js"
import type { NameKana } from "../../src/domain/value-objects/NameKana.js"
import type { PhoneLast4 } from "../../src/domain/value-objects/PhoneLast4.js"
import type { ResourceType } from "../../src/domain/value-objects/ResourceType.js"
import type { Skill } from "../../src/domain/value-objects/Skill.js"

/*
 * Type-level regression suite for branded types. Each assertion exercises:
 *   - the brand is assignable to its base type (`brand → base`)
 *   - the base type is **not** assignable to the brand (`base ↛ brand`)
 *   - sibling brands are mutually disjoint (no accidental crossover)
 *
 * `expectTypeOf` is evaluated at compile time by tsc, so a failure
 * fails the build, not just the test run.
 */

test("string-backed value-object brands behave like phantom strings", () => {
  expectTypeOf<PhoneLast4>().toMatchTypeOf<string>()
  expectTypeOf<NameKana>().toMatchTypeOf<string>()
  expectTypeOf<FreeText>().toMatchTypeOf<string>()
  expectTypeOf<BookingCode>().toMatchTypeOf<string>()
  expectTypeOf<BusinessTimeZone>().toMatchTypeOf<string>()
  expectTypeOf<Skill>().toMatchTypeOf<string>()
  expectTypeOf<ResourceType>().toMatchTypeOf<string>()

  expectTypeOf<string>().not.toMatchTypeOf<PhoneLast4>()
  expectTypeOf<string>().not.toMatchTypeOf<NameKana>()
  expectTypeOf<string>().not.toMatchTypeOf<BookingCode>()
})

test("number-backed value-object brands behave like phantom numbers", () => {
  expectTypeOf<Minutes>().toMatchTypeOf<number>()
  expectTypeOf<HoldingDays>().toMatchTypeOf<number>()

  expectTypeOf<number>().not.toMatchTypeOf<Minutes>()
  expectTypeOf<number>().not.toMatchTypeOf<HoldingDays>()
})

test("string-backed value-object brands are mutually disjoint", () => {
  expectTypeOf<PhoneLast4>().not.toMatchTypeOf<NameKana>()
  expectTypeOf<NameKana>().not.toMatchTypeOf<PhoneLast4>()
  expectTypeOf<PhoneLast4>().not.toMatchTypeOf<BookingCode>()
  expectTypeOf<BookingCode>().not.toMatchTypeOf<PhoneLast4>()
  expectTypeOf<NameKana>().not.toMatchTypeOf<FreeText>()
  expectTypeOf<Skill>().not.toMatchTypeOf<ResourceType>()
})

test("number-backed brands are mutually disjoint", () => {
  expectTypeOf<Minutes>().not.toMatchTypeOf<HoldingDays>()
  expectTypeOf<HoldingDays>().not.toMatchTypeOf<Minutes>()
})

test("EntityId brands behave like phantom strings", () => {
  expectTypeOf<BookingId>().toMatchTypeOf<string>()
  expectTypeOf<ServiceId>().toMatchTypeOf<string>()
  expectTypeOf<ProviderId>().toMatchTypeOf<string>()
  expectTypeOf<ResourceId>().toMatchTypeOf<string>()
  expectTypeOf<ClosureId>().toMatchTypeOf<string>()
  expectTypeOf<ProviderAbsenceId>().toMatchTypeOf<string>()
  expectTypeOf<BusinessHoursId>().toMatchTypeOf<string>()
  expectTypeOf<BookingEventId>().toMatchTypeOf<string>()
  expectTypeOf<AuditLogId>().toMatchTypeOf<string>()
  expectTypeOf<IdempotencyKeyId>().toMatchTypeOf<string>()

  expectTypeOf<string>().not.toMatchTypeOf<BookingId>()
  expectTypeOf<string>().not.toMatchTypeOf<ServiceId>()
})

test("EntityId brands are mutually disjoint (no crossover)", () => {
  expectTypeOf<BookingId>().not.toMatchTypeOf<ServiceId>()
  expectTypeOf<ServiceId>().not.toMatchTypeOf<ProviderId>()
  expectTypeOf<ProviderId>().not.toMatchTypeOf<ResourceId>()
  expectTypeOf<ResourceId>().not.toMatchTypeOf<ClosureId>()
  expectTypeOf<BookingEventId>().not.toMatchTypeOf<BookingId>()
  expectTypeOf<AuditLogId>().not.toMatchTypeOf<IdempotencyKeyId>()
})
