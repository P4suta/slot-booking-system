import { Context, type Effect } from "effect"
import type { BusinessHours } from "../../domain/entities/BusinessHours.js"
import type { Closure } from "../../domain/entities/Closure.js"
import type { Provider } from "../../domain/entities/Provider.js"
import type { ProviderAbsence } from "../../domain/entities/ProviderAbsence.js"
import type { Resource } from "../../domain/entities/Resource.js"
import type { Service } from "../../domain/entities/Service.js"
import type { AggregateNotFoundError, StorageError } from "../../domain/errors/Errors.js"
import type {
  BusinessHoursId,
  ClosureId,
  ProviderAbsenceId,
  ProviderId,
  ResourceId,
  ServiceId,
} from "../../domain/types/EntityId.js"

/**
 * CRUD surface for one catalog entity. Six instances of this shape live
 * inside {@link ServiceCatalog}, one per business entity. Keeping the
 * row-level operations behind a uniform `Repository<E, I>` lets staff
 * mutations (Phase 0.8-4) and slot-search reads (Phase 0.9) share the
 * same vocabulary.
 *
 *   - `list` returns every row, including disabled ones — slot search
 *     filters by `enabled`, but the staff dashboard wants to see them.
 *   - `get` resolves a single id; absent rows surface as
 *     `AggregateNotFoundError` so the use case can choose between
 *     "stale id from client" and "FK target deleted".
 *   - `save` is upsert; the adapter decides between INSERT / UPDATE
 *     based on the id's existence. Domain validity is the caller's
 *     responsibility — the entity is already a parsed domain value.
 *   - `delete` removes one row. Cascade and FK integrity live in the
 *     adapter (D1 has no enforced FKs); the use case rejects orphan-
 *     producing deletes before reaching this port.
 */
export type CatalogRepository<E, I> = {
  readonly list: () => Effect.Effect<readonly E[], StorageError>
  readonly get: (id: I) => Effect.Effect<E, AggregateNotFoundError | StorageError>
  readonly save: (entity: E) => Effect.Effect<void, StorageError>
  readonly delete: (id: I) => Effect.Effect<void, StorageError>
}

/**
 * Aggregate port covering every catalog entity. Slot computation
 * (`computeAvailableSlots`) consumes the read side via `list*` calls
 * and assembles a `SlotCalcEnv`; staff mutations call the per-entity
 * `save` / `delete` methods.
 *
 * Concrete adapters:
 *   - `D1ServiceCatalogLive` — Drizzle over the D1 binding (production
 *     and `wrangler dev --local`)
 *   - `InMemoryServiceCatalogLive` — STM-backed fake for unit tests
 *
 * The port is **not** transactional across entities; cross-entity
 * invariants (e.g. provider in `provider_absences` must exist in
 * `providers`) are kept by the use cases that orchestrate writes,
 * not by the port. The catalog is small and rarely mutated, so a
 * full multi-entity transaction is overkill.
 */
export type ServiceCatalogOps = {
  readonly services: CatalogRepository<Service, ServiceId>
  readonly providers: CatalogRepository<Provider, ProviderId>
  readonly resources: CatalogRepository<Resource, ResourceId>
  readonly businessHours: CatalogRepository<BusinessHours, BusinessHoursId>
  readonly closures: CatalogRepository<Closure, ClosureId>
  readonly providerAbsences: CatalogRepository<ProviderAbsence, ProviderAbsenceId>
}

export class ServiceCatalog extends Context.Service<ServiceCatalog, ServiceCatalogOps>()(
  "@booking/core/ServiceCatalog",
) {}
