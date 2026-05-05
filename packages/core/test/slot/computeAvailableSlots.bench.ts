import { bench, describe } from "vitest"
import type { Provider } from "../../src/domain/entities/Provider.js"
import type { Resource } from "../../src/domain/entities/Resource.js"
import { computeAvailableSlots } from "../../src/domain/slot/computeAvailableSlots.js"
import type { ProviderId, ResourceId } from "../../src/domain/types/EntityId.js"
import { baseEnv, baseQuery, SKILL_GENERAL, TYPE_WORKSPACE } from "../_fixtures/index.js"

const providers = (n: number): Provider[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `prov_${String(i).padStart(8, "0")}` as ProviderId,
    name: `P${i.toString()}`,
    skills: new Set([SKILL_GENERAL]),
    enabled: true,
  }))

const resources = (n: number): Resource[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `rsrc_${String(i).padStart(8, "0")}` as ResourceId,
    name: `R${i.toString()}`,
    type: TYPE_WORKSPACE,
    enabled: true,
  }))

const grid = (P: number, R: number, granularityMinutes: number) =>
  [
    baseEnv({
      providers: providers(P),
      resources: resources(R),
      slotGranularityMinutes: granularityMinutes,
    }),
    baseQuery(),
  ] as const

describe("computeAvailableSlots — performance", () => {
  bench("typical: 5 providers × 5 resources, 30-min granularity", () => {
    computeAvailableSlots(...grid(5, 5, 30))
  })

  bench("dense: 10 providers × 10 resources, 15-min granularity", () => {
    computeAvailableSlots(...grid(10, 10, 15))
  })

  bench("worst-case grid: 20 providers × 20 resources, 5-min granularity", () => {
    computeAvailableSlots(...grid(20, 20, 5))
  })
})
