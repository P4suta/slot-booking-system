import { Effect, HashMap, Layer, Option, Ref } from "effect"
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
 * `Ref`-backed in-memory {@link ServiceCatalog}. Six independent
 * `Ref<HashMap<I, E>>` instances, one per entity. `Ref.update` gives
 * the per-row upsert / delete pair atomicity (a reader can never
 * observe a partial write); cross-entity invariants are intentionally
 * not enforced — they belong in the use case layer (see
 * `application/ports/ServiceCatalog.ts`).
 *
 * Effect 4 removed STM/TMap; per-entity `Ref<HashMap>` keeps the same
 * "atomic at the row level" guarantee while collapsing the
 * transactional dependency. Cross-entity transactions were never
 * supported here, so nothing about the contract weakens.
 */

const repositoryFromRef = <E extends { readonly id: I }, I>(
  ref: Ref.Ref<HashMap.HashMap<I, E>>,
): CatalogRepository<E, I> => ({
  list: () => Effect.map(Ref.get(ref), (m) => Array.from(HashMap.values(m)) as readonly E[]),
  get: (id) =>
    Effect.flatMap(Ref.get(ref), (m) =>
      Option.match(HashMap.get(m, id), {
        onNone: () => Effect.fail(new AggregateNotFoundError({})),
        onSome: (entity) => Effect.succeed(entity),
      }),
    ),
  save: (entity) => Ref.update(ref, (m) => HashMap.set(m, entity.id, entity)),
  delete: (id) => Ref.update(ref, (m) => HashMap.remove(m, id)),
})

export const makeInMemoryServiceCatalog = (): Layer.Layer<ServiceCatalog> =>
  Layer.effect(
    ServiceCatalog,
    Effect.gen(function* () {
      const services = yield* Ref.make(HashMap.empty<ServiceId, Service>())
      const providers = yield* Ref.make(HashMap.empty<ProviderId, Provider>())
      const resources = yield* Ref.make(HashMap.empty<ResourceId, Resource>())
      const businessHours = yield* Ref.make(HashMap.empty<BusinessHoursId, BusinessHours>())
      const closures = yield* Ref.make(HashMap.empty<ClosureId, Closure>())
      const providerAbsences = yield* Ref.make(HashMap.empty<ProviderAbsenceId, ProviderAbsence>())
      return ServiceCatalog.of({
        services: repositoryFromRef(services),
        providers: repositoryFromRef(providers),
        resources: repositoryFromRef(resources),
        businessHours: repositoryFromRef(businessHours),
        closures: repositoryFromRef(closures),
        providerAbsences: repositoryFromRef(providerAbsences),
      })
    }),
  )

/** Convenience: a single fresh, empty catalog per Effect runtime. */
export const InMemoryServiceCatalogLive = makeInMemoryServiceCatalog()
