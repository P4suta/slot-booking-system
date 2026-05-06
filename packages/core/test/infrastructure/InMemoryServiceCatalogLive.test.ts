import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { ServiceCatalog } from "../../src/application/ports/ServiceCatalog.js"
import type { Closure } from "../../src/domain/entities/Closure.js"
import type { ProviderAbsence } from "../../src/domain/entities/ProviderAbsence.js"
import type {
  ClosureId,
  ProviderAbsenceId,
  ResourceId,
  ServiceId,
} from "../../src/domain/types/EntityId.js"
import { makeInMemoryServiceCatalog } from "../../src/infrastructure/serviceCatalog/InMemoryServiceCatalogLive.js"
import { at, date } from "../_fixtures/instants.js"
import {
  baseService,
  bhAllWeekdays,
  providerA,
  providerB,
  resource1,
  resource2,
} from "../_fixtures/world.js"

const layer = makeInMemoryServiceCatalog()

const run = <A, E>(eff: Effect.Effect<A, E, ServiceCatalog>) =>
  Effect.runPromiseExit(eff.pipe(Effect.provide(layer)))

const closureFixture: Closure = {
  id: "clos_x" as ClosureId,
  date: date("2026-05-12"),
  reason: "maintenance",
}

const absenceFixture: ProviderAbsence = {
  id: "absn_x" as ProviderAbsenceId,
  providerId: providerA.id,
  start: at("2026-05-11T10:00:00Z"),
  end: at("2026-05-11T12:00:00Z"),
  reason: "training",
}

describe("InMemoryServiceCatalog", () => {
  it("starts empty for every entity", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const cat = yield* ServiceCatalog
        return {
          services: yield* cat.services.list(),
          providers: yield* cat.providers.list(),
          resources: yield* cat.resources.list(),
          businessHours: yield* cat.businessHours.list(),
          closures: yield* cat.closures.list(),
          providerAbsences: yield* cat.providerAbsences.list(),
        }
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.services).toEqual([])
      expect(exit.value.providers).toEqual([])
      expect(exit.value.resources).toEqual([])
      expect(exit.value.businessHours).toEqual([])
      expect(exit.value.closures).toEqual([])
      expect(exit.value.providerAbsences).toEqual([])
    }
  })

  it("save then list returns the row for every entity", async () => {
    const bhMon = bhAllWeekdays.get(1 as never)
    if (!bhMon) throw new Error("missing fixture")
    const exit = await run(
      Effect.gen(function* () {
        const cat = yield* ServiceCatalog
        yield* cat.services.save(baseService)
        yield* cat.providers.save(providerA)
        yield* cat.providers.save(providerB)
        yield* cat.resources.save(resource1)
        yield* cat.resources.save(resource2)
        yield* cat.businessHours.save(bhMon)
        yield* cat.closures.save(closureFixture)
        yield* cat.providerAbsences.save(absenceFixture)
        return {
          services: yield* cat.services.list(),
          providers: yield* cat.providers.list(),
          resources: yield* cat.resources.list(),
          businessHours: yield* cat.businessHours.list(),
          closures: yield* cat.closures.list(),
          providerAbsences: yield* cat.providerAbsences.list(),
        }
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.services).toHaveLength(1)
      expect(exit.value.providers).toHaveLength(2)
      expect(exit.value.resources).toHaveLength(2)
      expect(exit.value.businessHours).toHaveLength(1)
      expect(exit.value.closures[0]?.id).toBe(closureFixture.id)
      expect(exit.value.providerAbsences[0]?.id).toBe(absenceFixture.id)
    }
  })

  it("get returns the saved entity by id", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const cat = yield* ServiceCatalog
        yield* cat.services.save(baseService)
        return yield* cat.services.get(baseService.id)
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.id).toBe(baseService.id)
    }
  })

  it("get fails with AggregateNotFound for an unknown id", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const cat = yield* ServiceCatalog
        return yield* cat.services.get("serv_missing" as ServiceId)
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("AggregateNotFound")
    }
  })

  it("save is upsert: same id replaces the prior row", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const cat = yield* ServiceCatalog
        yield* cat.providers.save(providerA)
        yield* cat.providers.save({ ...providerA, name: "renamed" })
        return yield* cat.providers.get(providerA.id)
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.name).toBe("renamed")
    }
  })

  it("delete removes the row", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const cat = yield* ServiceCatalog
        yield* cat.resources.save(resource1)
        yield* cat.resources.delete(resource1.id)
        return yield* cat.resources.list()
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual([])
    }
  })

  it("delete is a no-op for an unknown id (no error surfaced)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const cat = yield* ServiceCatalog
        return yield* cat.resources.delete("rsrc_missing" as ResourceId)
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("entities live in their own namespace — no cross-talk on save", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const cat = yield* ServiceCatalog
        yield* cat.providers.save(providerA)
        return yield* cat.services.list()
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual([])
    }
  })

  it("each makeInMemoryServiceCatalog() Layer is a fresh, isolated catalog", async () => {
    const layerA = makeInMemoryServiceCatalog()
    const layerB = makeInMemoryServiceCatalog()
    await Effect.runPromise(
      Effect.gen(function* () {
        const cat = yield* ServiceCatalog
        yield* cat.providers.save(providerA)
      }).pipe(Effect.provide(layerA)),
    )
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const cat = yield* ServiceCatalog
        return yield* cat.providers.list()
      }).pipe(Effect.provide(layerB)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual([])
    }
  })
})
