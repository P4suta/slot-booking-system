import { Effect, type Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  type CatalogRepository,
  ServiceCatalog,
  type ServiceCatalogOps,
} from "../../src/application/ports/ServiceCatalog.js"
import { schemaToArbitrary } from "../../src/derive/index.js"
import { ProviderSchema, ResourceSchema, ServiceSchema } from "../../src/domain/index.js"
import { makeInMemoryServiceCatalog } from "../../src/infrastructure/serviceCatalog/InMemoryServiceCatalogLive.js"

/**
 * Property suite for the catalog port. Each non-Temporal entity is
 * exercised through its own `Schema → Arbitrary` derivation
 * (Phase 0.7-β3) so the generators stay coupled to the domain — no
 * hand-rolled fixtures.
 *
 * Three properties are pinned per repository:
 *
 *   1. **save / get round-trip** — save an entity, immediately get(id),
 *      and the loaded record carries the same id.
 *   2. **save / delete absence** — save then delete leaves get(id)
 *      failing with `AggregateNotFound`.
 *   3. **upsert idempotence** — saving the same id twice yields
 *      exactly one row in `list()`; the second save replaces.
 *
 * Cross-entity isolation: writes to one repository do not affect any
 * other (the in-memory backing store is a per-entity `TMap`).
 *
 * `BusinessHours`, `Closure`, and `ProviderAbsence` carry Temporal
 * values. The Temporal Schemas use `Schema.declare(...)` without an
 * `arbitrary` annotation, so `schemaToArbitrary` can't synthesise a
 * generator for them. Their CRUD invariants are kept in
 * `infrastructure/InMemoryServiceCatalogLive.test.ts` with hand-built
 * fixtures; once the Temporal Schemas advertise an arbitrary
 * annotation (Phase 0.12 follow-up), they fold back into this suite
 * trivially.
 */

const propertyTriad = <E extends { readonly id: I }, I, R>(
  label: string,
  schema: Schema.Schema<E, R>,
  pickRepo: (cat: ServiceCatalogOps) => CatalogRepository<E, I>,
): void => {
  const arbEntity = schemaToArbitrary(schema)

  describe(label, () => {
    it(`save → get round-trips for ${label}`, async () => {
      await fc.assert(
        fc.asyncProperty(arbEntity, async (entity) => {
          const result = await Effect.runPromise(
            Effect.flatMap(ServiceCatalog, (cat) => {
              const repo = pickRepo(cat)
              return Effect.gen(function* () {
                yield* repo.save(entity)
                return yield* repo.get(entity.id)
              })
            }).pipe(Effect.provide(makeInMemoryServiceCatalog())),
          )
          expect(result.id).toBe(entity.id)
        }),
        { numRuns: 30 },
      )
    })

    it(`save → delete absences for ${label}`, async () => {
      await fc.assert(
        fc.asyncProperty(arbEntity, async (entity) => {
          const exit = await Effect.runPromiseExit(
            Effect.flatMap(ServiceCatalog, (cat) => {
              const repo = pickRepo(cat)
              return Effect.gen(function* () {
                yield* repo.save(entity)
                yield* repo.delete(entity.id)
                return yield* repo.get(entity.id)
              })
            }).pipe(Effect.provide(makeInMemoryServiceCatalog())),
          )
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            expect(JSON.stringify(exit.cause)).toContain("AggregateNotFound")
          }
        }),
        { numRuns: 30 },
      )
    })

    it(`upsert is idempotent for ${label}`, async () => {
      await fc.assert(
        fc.asyncProperty(arbEntity, async (entity) => {
          const list = await Effect.runPromise(
            Effect.flatMap(ServiceCatalog, (cat) => {
              const repo = pickRepo(cat)
              return Effect.gen(function* () {
                yield* repo.save(entity)
                yield* repo.save(entity)
                return yield* repo.list()
              })
            }).pipe(Effect.provide(makeInMemoryServiceCatalog())),
          )
          expect(list.length).toBe(1)
        }),
        { numRuns: 30 },
      )
    })
  })
}

describe("catalog property suite", () => {
  propertyTriad("services", ServiceSchema, (cat) => cat.services)
  propertyTriad("providers", ProviderSchema, (cat) => cat.providers)
  propertyTriad("resources", ResourceSchema, (cat) => cat.resources)

  it("writes to one repository do not bleed into another", async () => {
    await fc.assert(
      fc.asyncProperty(
        schemaToArbitrary(ServiceSchema),
        schemaToArbitrary(ProviderSchema),
        async (svc, prov) => {
          const counts = await Effect.runPromise(
            Effect.flatMap(ServiceCatalog, (cat) =>
              Effect.gen(function* () {
                yield* cat.services.save(svc)
                yield* cat.providers.save(prov)
                const services = yield* cat.services.list()
                const resources = yield* cat.resources.list()
                const closures = yield* cat.closures.list()
                return {
                  services: services.length,
                  resources: resources.length,
                  closures: closures.length,
                }
              }),
            ).pipe(Effect.provide(makeInMemoryServiceCatalog())),
          )
          expect(counts.services).toBe(1)
          expect(counts.resources).toBe(0)
          expect(counts.closures).toBe(0)
        },
      ),
      { numRuns: 20 },
    )
  })
})
