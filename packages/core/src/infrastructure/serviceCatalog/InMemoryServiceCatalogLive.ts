import { Effect, Layer, STM, TMap } from "effect"
import { type CatalogRepository, ServiceCatalog } from "../../application/ports/ServiceCatalog.js"
import type { BusinessHours } from "../../domain/entities/BusinessHours.js"
import type { Closure } from "../../domain/entities/Closure.js"
import type { Provider } from "../../domain/entities/Provider.js"
import type { ProviderAbsence } from "../../domain/entities/ProviderAbsence.js"
import type { Resource } from "../../domain/entities/Resource.js"
import type { Service } from "../../domain/entities/Service.js"
import { AggregateNotFoundError } from "../../domain/errors/Errors.js"
import type {
  BusinessHoursId,
  ClosureId,
  ProviderAbsenceId,
  ProviderId,
  ResourceId,
  ServiceId,
} from "../../domain/types/EntityId.js"

/**
 * STM-backed in-memory {@link ServiceCatalog}. Six independent
 * `TMap<I, E>` instances, one per entity. STM gives the per-row
 * upsert / delete pair atomicity (a reader can never observe a
 * partial write); cross-entity invariants are intentionally not
 * enforced — they belong in the use case layer (see
 * `application/ports/ServiceCatalog.ts`).
 *
 * The factory returns a fresh, empty layer; each test mounts its own
 * instance so per-test fixtures stay isolated. There is no global
 * singleton — Effect runtimes that share a layer share the catalog.
 */

const repositoryFromTMap = <E extends { readonly id: I }, I>(
  map: TMap.TMap<I, E>,
): CatalogRepository<E, I> => ({
  list: () => Effect.map(STM.commit(TMap.values(map)), (rows) => rows as readonly E[]),
  get: (id) =>
    STM.commit(
      STM.flatMap(TMap.get(map, id), (opt) =>
        opt._tag === "Some" ? STM.succeed(opt.value) : STM.fail(new AggregateNotFoundError({})),
      ),
    ),
  save: (entity) => STM.commit(TMap.set(map, entity.id, entity)),
  delete: (id) => STM.commit(TMap.remove(map, id)),
})

export const makeInMemoryServiceCatalog = (): Layer.Layer<ServiceCatalog> =>
  Layer.effect(
    ServiceCatalog,
    Effect.gen(function* () {
      const services = yield* STM.commit(TMap.empty<ServiceId, Service>())
      const providers = yield* STM.commit(TMap.empty<ProviderId, Provider>())
      const resources = yield* STM.commit(TMap.empty<ResourceId, Resource>())
      const businessHours = yield* STM.commit(TMap.empty<BusinessHoursId, BusinessHours>())
      const closures = yield* STM.commit(TMap.empty<ClosureId, Closure>())
      const providerAbsences = yield* STM.commit(TMap.empty<ProviderAbsenceId, ProviderAbsence>())
      return ServiceCatalog.of({
        services: repositoryFromTMap(services),
        providers: repositoryFromTMap(providers),
        resources: repositoryFromTMap(resources),
        businessHours: repositoryFromTMap(businessHours),
        closures: repositoryFromTMap(closures),
        providerAbsences: repositoryFromTMap(providerAbsences),
      })
    }),
  )

/** Convenience: a single fresh, empty catalog per Effect runtime. */
export const InMemoryServiceCatalogLive = makeInMemoryServiceCatalog()
