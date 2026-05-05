/**
 * Default test world: industry-agnostic Service / Providers / Resources
 * / BusinessHours used across slot-calc tests and benches. Tests can
 * destructure or override individual pieces; `baseInput()` produces a
 * ready-to-call `SlotCalcInput` with sensible defaults that fail any
 * tester whose change of behaviour would surprise the caller.
 */
import { makeBusinessHours } from "../../src/domain/entities/BusinessHours.js"
import type { Provider } from "../../src/domain/entities/Provider.js"
import type { Resource } from "../../src/domain/entities/Resource.js"
import type { Service } from "../../src/domain/entities/Service.js"
import type { SlotCalcInput } from "../../src/domain/slot/computeAvailableSlots.js"
import type {
  BusinessHoursId,
  ProviderId,
  ResourceId,
  ServiceId,
} from "../../src/domain/types/EntityId.js"
import { minutesUnchecked } from "../../src/domain/value-objects/Duration.js"
import { at, date } from "./instants.js"
import {
  businessTimeZone,
  holdingDays,
  openWindow,
  resourceType,
  skill,
  weekday,
} from "./parsers.js"

export const TZ = businessTimeZone("Asia/Tokyo")
export const SKILL_GENERAL = skill("general")
export const TYPE_WORKSPACE = resourceType("workspace")

export const SERVICE_ID = "serv_default" as ServiceId
export const PROVIDER_ID_A = "prov_aaa" as ProviderId
export const PROVIDER_ID_B = "prov_bbb" as ProviderId
export const RESOURCE_ID_1 = "rsrc_111" as ResourceId
export const RESOURCE_ID_2 = "rsrc_222" as ResourceId

export const baseService: Service = {
  id: SERVICE_ID,
  name: "Test Service",
  description: "",
  durationMinutes: minutesUnchecked(60),
  bufferBeforeMinutes: minutesUnchecked(0),
  bufferAfterMinutes: minutesUnchecked(15),
  holdingDays: holdingDays(0),
  requiredSkills: new Set([SKILL_GENERAL]),
  requiredResourceTypes: new Set([TYPE_WORKSPACE]),
  enabled: true,
}

export const providerA: Provider = {
  id: PROVIDER_ID_A,
  name: "A",
  skills: new Set([SKILL_GENERAL]),
  enabled: true,
}

export const providerB: Provider = {
  id: PROVIDER_ID_B,
  name: "B",
  skills: new Set([SKILL_GENERAL]),
  enabled: true,
}

export const resource1: Resource = {
  id: RESOURCE_ID_1,
  name: "ws-1",
  type: TYPE_WORKSPACE,
  enabled: true,
}

export const resource2: Resource = {
  id: RESOURCE_ID_2,
  name: "ws-2",
  type: TYPE_WORKSPACE,
  enabled: true,
}

const bhId = (n: number): BusinessHoursId => `bhrs_${n.toString()}` as BusinessHoursId

/** Mon..Sun, all open 10:00..18:00. Tests override entries when needed. */
export const bhAllWeekdays = new Map(
  [1, 2, 3, 4, 5, 6, 7].map((n) => {
    const wd = weekday(n)
    return [wd, makeBusinessHours(bhId(n), wd, [openWindow(10, 18)])] as const
  }),
)

export const baseInput = (overrides: Partial<SlotCalcInput> = {}): SlotCalcInput => ({
  service: baseService,
  date: date("2026-05-11"), // Monday
  timeZone: TZ,
  businessHoursByWeekday: bhAllWeekdays,
  closures: [],
  providers: [providerA, providerB],
  resources: [resource1, resource2],
  providerAbsences: [],
  servicesById: new Map([[SERVICE_ID, baseService]]),
  existingBookings: [],
  now: at("2026-05-10T00:00:00Z"),
  slotGranularityMinutes: 30,
  ...overrides,
})
