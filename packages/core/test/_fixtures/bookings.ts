/**
 * Booking fixtures for state-machine and slot-calc tests.
 */
import type { Confirmed, Held } from "../../src/domain/booking/Booking.js"
import {
  newBookingId,
  newProviderId,
  newResourceId,
  newServiceId,
  type ProviderId,
  type ResourceId,
  type ServiceId,
} from "../../src/domain/types/EntityId.js"
import type { TimeSlot } from "../../src/domain/value-objects/TimeSlot.js"
import { at, slot } from "./instants.js"
import { bookingCode, freeText, kana, phone } from "./parsers.js"
import { SERVICE_ID } from "./world.js"

/**
 * A `Held` booking with sane defaults — used by transitions tests
 * that exercise the (state, command) matrix without caring about the
 * surrounding world.
 */
export const baseHeld = (overrides: Partial<Held> = {}): Held => ({
  id: newBookingId(),
  code: bookingCode(123_456n),
  serviceId: newServiceId(),
  providerId: newProviderId(),
  resourceIds: [newResourceId()],
  slot: slot("2026-05-10T01:00:00Z", "2026-05-10T02:00:00Z"),
  source: "online",
  nameKana: kana("ヤマダ タロウ"),
  phoneLast4: phone("1234"),
  freeText: freeText("note"),
  state: "Held",
  heldAt: at("2026-05-09T12:00:00Z"),
  expiresAt: at("2026-05-09T12:05:00Z"),
  ...overrides,
})

/**
 * A `Confirmed` booking pinned to a specific provider / resources /
 * slot. The default `serviceId` matches the slot-calc world's
 * `SERVICE_ID` so existing-booking interactions are looked up
 * correctly via `servicesById`.
 */
export const confirmedBooking = (params: {
  providerId: ProviderId
  resourceIds: readonly ResourceId[]
  slot: TimeSlot
  serviceId?: ServiceId
}): Confirmed => ({
  id: newBookingId(),
  code: bookingCode(0n),
  serviceId: params.serviceId ?? SERVICE_ID,
  providerId: params.providerId,
  resourceIds: params.resourceIds,
  slot: params.slot,
  source: "online",
  nameKana: kana("ヤマダ タロウ"),
  phoneLast4: phone("1234"),
  freeText: freeText(""),
  state: "Confirmed",
  confirmedAt: at("2026-05-09T12:00:00Z"),
})
