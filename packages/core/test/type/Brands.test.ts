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
  StaffId,
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
  expectTypeOf<PhoneLast4>().toExtend<string>()
  expectTypeOf<NameKana>().toExtend<string>()
  expectTypeOf<FreeText>().toExtend<string>()
  expectTypeOf<BookingCode>().toExtend<string>()
  expectTypeOf<BusinessTimeZone>().toExtend<string>()
  expectTypeOf<Skill>().toExtend<string>()
  expectTypeOf<ResourceType>().toExtend<string>()

  expectTypeOf<string>().not.toExtend<PhoneLast4>()
  expectTypeOf<string>().not.toExtend<NameKana>()
  expectTypeOf<string>().not.toExtend<BookingCode>()
})

test("number-backed value-object brands behave like phantom numbers", () => {
  expectTypeOf<Minutes>().toExtend<number>()
  expectTypeOf<HoldingDays>().toExtend<number>()

  expectTypeOf<number>().not.toExtend<Minutes>()
  expectTypeOf<number>().not.toExtend<HoldingDays>()
})

test("string-backed value-object brands are mutually disjoint", () => {
  expectTypeOf<PhoneLast4>().not.toExtend<NameKana>()
  expectTypeOf<NameKana>().not.toExtend<PhoneLast4>()
  expectTypeOf<PhoneLast4>().not.toExtend<BookingCode>()
  expectTypeOf<BookingCode>().not.toExtend<PhoneLast4>()
  expectTypeOf<NameKana>().not.toExtend<FreeText>()
  expectTypeOf<Skill>().not.toExtend<ResourceType>()
})

test("number-backed brands are mutually disjoint", () => {
  expectTypeOf<Minutes>().not.toExtend<HoldingDays>()
  expectTypeOf<HoldingDays>().not.toExtend<Minutes>()
})

test("EntityId brands behave like phantom strings", () => {
  expectTypeOf<BookingId>().toExtend<string>()
  expectTypeOf<ServiceId>().toExtend<string>()
  expectTypeOf<ProviderId>().toExtend<string>()
  expectTypeOf<ResourceId>().toExtend<string>()
  expectTypeOf<ClosureId>().toExtend<string>()
  expectTypeOf<ProviderAbsenceId>().toExtend<string>()
  expectTypeOf<BusinessHoursId>().toExtend<string>()
  expectTypeOf<BookingEventId>().toExtend<string>()
  expectTypeOf<AuditLogId>().toExtend<string>()
  expectTypeOf<IdempotencyKeyId>().toExtend<string>()
  expectTypeOf<StaffId>().toExtend<string>()

  expectTypeOf<string>().not.toExtend<BookingId>()
  expectTypeOf<string>().not.toExtend<ServiceId>()
  expectTypeOf<string>().not.toExtend<StaffId>()
})

test("EntityId brands are mutually disjoint (no crossover)", () => {
  expectTypeOf<BookingId>().not.toExtend<ServiceId>()
  expectTypeOf<ServiceId>().not.toExtend<ProviderId>()
  expectTypeOf<ProviderId>().not.toExtend<ResourceId>()
  expectTypeOf<ResourceId>().not.toExtend<ClosureId>()
  expectTypeOf<BookingEventId>().not.toExtend<BookingId>()
  expectTypeOf<AuditLogId>().not.toExtend<IdempotencyKeyId>()
  expectTypeOf<StaffId>().not.toExtend<BookingId>()
  expectTypeOf<StaffId>().not.toExtend<BookingEventId>()
})
