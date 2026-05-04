import { Temporal } from "@js-temporal/polyfill"
import { Either } from "effect"
import { bench, describe } from "vitest"
import { makeBusinessHours } from "../../src/domain/entities/BusinessHours.js"
import { makeOpenWindow } from "../../src/domain/entities/OpenWindow.js"
import type { Provider } from "../../src/domain/entities/Provider.js"
import type { Resource } from "../../src/domain/entities/Resource.js"
import type { Service } from "../../src/domain/entities/Service.js"
import { parseWeekday, type Weekday } from "../../src/domain/entities/Weekday.js"
import { computeAvailableSlots } from "../../src/domain/slot/computeAvailableSlots.js"
import type {
  BusinessHoursId,
  ProviderId,
  ResourceId,
  ServiceId,
} from "../../src/domain/types/EntityId.js"
import { parseBusinessTimeZone } from "../../src/domain/value-objects/BusinessTimeZone.js"
import { minutesUnchecked } from "../../src/domain/value-objects/Duration.js"
import { parseHoldingDays } from "../../src/domain/value-objects/HoldingDays.js"
import { parseResourceType } from "../../src/domain/value-objects/ResourceType.js"
import { parseSkill } from "../../src/domain/value-objects/Skill.js"

const tz = Either.getOrThrow(parseBusinessTimeZone("Asia/Tokyo"))
const skill = Either.getOrThrow(parseSkill("general"))
const wsType = Either.getOrThrow(parseResourceType("workspace"))
const wd = (n: number): Weekday => Either.getOrThrow(parseWeekday(n))
const t = (h: number) => Temporal.PlainTime.from({ hour: h, minute: 0 })
const win = (a: number, b: number) => Either.getOrThrow(makeOpenWindow(t(a), t(b)))

const SERVICE_ID = "serv_bench" as ServiceId
const service: Service = {
  id: SERVICE_ID,
  name: "bench",
  description: "",
  durationMinutes: minutesUnchecked(60),
  bufferBeforeMinutes: minutesUnchecked(0),
  bufferAfterMinutes: minutesUnchecked(15),
  holdingDays: Either.getOrThrow(parseHoldingDays(0)),
  requiredSkills: new Set([skill]),
  requiredResourceTypes: new Set([wsType]),
  enabled: true,
}

const providers = (n: number): Provider[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `prov_${String(i).padStart(8, "0")}` as ProviderId,
    name: `P${i}`,
    skills: new Set([skill]),
    enabled: true,
  }))

const resources = (n: number): Resource[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `rsrc_${String(i).padStart(8, "0")}` as ResourceId,
    name: `R${i}`,
    type: wsType,
    enabled: true,
  }))

const bh = new Map(
  ([1, 2, 3, 4, 5, 6, 7] as const).map((n) => [
    wd(n),
    makeBusinessHours(`bhrs_${n}` as BusinessHoursId, wd(n), [win(10, 18)]),
  ]),
)

const baseInput = (P: number, R: number, granularityMinutes: number) => ({
  service,
  date: Temporal.PlainDate.from("2026-05-11"),
  timeZone: tz,
  businessHoursByWeekday: bh,
  closures: [],
  providers: providers(P),
  resources: resources(R),
  providerAbsences: [],
  servicesById: new Map([[SERVICE_ID, service]]),
  existingBookings: [],
  now: Temporal.Instant.from("2026-05-10T00:00:00Z"),
  slotGranularityMinutes: granularityMinutes,
})

describe("computeAvailableSlots — performance", () => {
  bench("typical: 5 providers × 5 resources, 30-min granularity", () => {
    computeAvailableSlots(baseInput(5, 5, 30))
  })

  bench("dense: 10 providers × 10 resources, 15-min granularity", () => {
    computeAvailableSlots(baseInput(10, 10, 15))
  })

  bench("worst-case grid: 20 providers × 20 resources, 5-min granularity", () => {
    computeAvailableSlots(baseInput(20, 20, 5))
  })
})
