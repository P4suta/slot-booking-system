import type {
  CustomerCapability,
  StaffCapability,
  StaffScope,
  SystemCapability,
} from "../../src/domain/auth/Capability.js"
import type { StaffId } from "../../src/domain/types/EntityId.js"
import type { BookingCode } from "../../src/domain/value-objects/BookingCode.js"
import type { PhoneLast4 } from "../../src/domain/value-objects/PhoneLast4.js"

/**
 * Capability fixtures for transition / projection tests. Build by-hand
 * shapes (cast to the branded type) so individual tests don't have to
 * thread the full Schema decode pipeline. Production code mints
 * capabilities through {@link authenticateCustomer} / staff JWT verify
 * / DO alarm scheduler, never these helpers.
 */

const SAMPLE_CODE = "ABCD12$" as unknown as BookingCode
const SAMPLE_PHONE = "1234" as unknown as PhoneLast4

export const customerCap = (
  bookingCode: BookingCode = SAMPLE_CODE,
  phoneLast4: PhoneLast4 = SAMPLE_PHONE,
): CustomerCapability =>
  ({
    _tag: "CustomerCapability",
    bookingCode,
    phoneLast4,
  }) satisfies CustomerCapability

const SAMPLE_STAFF_ID = "staf_01jbfb7nzpmkcr8jjtdrckf2pn" as StaffId

export const staffCap = (
  scopes: readonly StaffScope[] = ["cancel", "reschedule", "complete", "noshow"],
  staffId: StaffId = SAMPLE_STAFF_ID,
): StaffCapability =>
  ({
    _tag: "StaffCapability",
    staffId,
    scopes: scopes as [StaffScope, ...StaffScope[]],
  }) satisfies StaffCapability

export const systemExpire = (): SystemCapability =>
  ({
    _tag: "SystemCapability",
    reason: "expire",
  }) satisfies SystemCapability

export const systemPurge = (): SystemCapability =>
  ({
    _tag: "SystemCapability",
    reason: "purge",
  }) satisfies SystemCapability
