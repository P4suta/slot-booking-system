import {
  AggregateNotFoundError,
  BusinessHoursFromRow,
  businessHours,
  type CatalogRepository,
  ClosureFromRow,
  closures,
  ProviderAbsenceFromRow,
  ProviderFromRow,
  providerAbsences,
  providers,
  ResourceFromRow,
  resources,
  ServiceCatalog,
  ServiceFromRow,
  StorageError,
  services,
} from "@booking/core"
import { eq, type InferInsertModel } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import { Effect, Layer, Schema } from "effect"

/**
 * D1-backed {@link ServiceCatalog}. Six per-entity {@link CatalogRepository}
 * instances are produced by one parametric factory — the row ↔ domain
 * round-trip is fully described by the entity's Effect Schema, so every
 * adapter collapses to *(table, schema)*.
 *
 * Why this factor:
 *   - Each catalog entity has the **same** CRUD surface (`list` / `get` /
 *     `save` / `delete`) and a Schema codec that already owns the
 *     row-shape ↔ domain isomorphism. Repeating six near-identical
 *     adapters would be code-as-data, not code-as-design.
 *   - Drizzle's typed JSON columns (`mode: "json"`, `mode: "boolean"`)
 *     speak the encoded form Schema produces, so the encode-then-insert
 *     and select-then-decode paths are total: no per-column casing.
 *   - Cross-entity invariants (orphaned absences, FK violations) are
 *     intentionally policed in the use cases — this adapter is a
 *     pure transport.
 *
 * One parametric factory + one binding per entity = six adapters.
 */

type DrizzleD1 = ReturnType<typeof drizzle>

/**
 * Minimum table shape the factory needs: a Drizzle SQLite table whose
 * primary key is a `text` column named `id`. `SQLiteTable & { id }` is
 * the structural intersection that satisfies the operations used here
 * (`from(table)` / `eq(table.id, …)` / `insert(table)` / `delete(table)`).
 */
type CatalogTable = SQLiteTable & { readonly id: SQLiteColumn }

const wrapStorage =
  (reason: string) =>
  <A, E>(eff: Effect.Effect<A, E>): Effect.Effect<A, E | StorageError> =>
    eff.pipe(Effect.catchDefect((d) => Effect.fail(new StorageError({ reason, cause: d }))))

/**
 * One parametric repository factory. The Schema is the entity codec,
 * the table is its Drizzle handle, and the encoded form `R` is the
 * shape Drizzle round-trips through the JSON / boolean / text columns.
 *
 * `decodeUnknownResult` is used for reads so a corrupt row surfaces as
 * a `StorageError` rather than a panic. Writes use `encodeSync` — the
 * caller has already decoded the entity, so re-encoding cannot fail.
 *
 * The Drizzle query builder's full row type is parametric in the table
 * generic; `T` is threaded through so `select().from(table)` and
 * `eq(table.id, id)` stay type-checked end-to-end without `any` casts.
 */
const makeRepository = <E extends { readonly id: I }, I extends string, R>(
  db: DrizzleD1,
  table: CatalogTable,
  schema: Schema.Codec<E, R>,
): CatalogRepository<E, I> => {
  const encode = Schema.encodeSync(schema)
  const decodeRow = Schema.decodeUnknownResult(schema)

  const decodeOrThrow = (row: unknown, label: string): E => {
    const r = decodeRow(row)
    if (r._tag === "Success") return r.success
    throw new StorageError({ reason: `D1 catalog ${label} decode`, cause: r.failure })
  }

  return {
    list: () =>
      wrapStorage(`D1 catalog list`)(
        Effect.tryPromise({
          try: async () => {
            const rows = await db.select().from(table).all()
            return (rows as readonly unknown[]).map((row) => decodeOrThrow(row, "list"))
          },
          catch: (e) => new StorageError({ reason: "D1 catalog list", cause: e }),
        }),
      ),

    get: (id) =>
      Effect.tryPromise({
        try: async () => {
          const row = await db.select().from(table).where(eq(table.id, id)).get()
          if (row === undefined) throw new AggregateNotFoundError({})
          return decodeOrThrow(row, "get")
        },
        catch: (e) => {
          if (e instanceof AggregateNotFoundError) return e
          if (e instanceof StorageError) return e
          return new StorageError({ reason: "D1 catalog get", cause: e })
        },
      }),

    save: (entity) =>
      Effect.tryPromise({
        try: async () => {
          // The Schema codec is constructed to match the table's
          // `$inferInsert` shape exactly; the cast records that
          // contract at the boundary so Drizzle's typed builder
          // accepts the row without per-column unpacking.
          const row = encode(entity) as InferInsertModel<typeof table>
          await db
            .insert(table)
            .values(row)
            .onConflictDoUpdate({ target: table.id, set: row })
            .run()
        },
        catch: (e) => new StorageError({ reason: "D1 catalog save", cause: e }),
      }),

    delete: (id) =>
      Effect.tryPromise({
        try: async () => {
          await db.delete(table).where(eq(table.id, id)).run()
        },
        catch: (e) => new StorageError({ reason: "D1 catalog delete", cause: e }),
      }),
  }
}

/* The catalog adapter is a Cartesian product of (table, schema) pairs
 * applied to the parametric factory above. Adding a seventh entity is
 * one binding — no per-entity SQL boilerplate.
 */
export const makeD1ServiceCatalog = (database: D1Database): Layer.Layer<ServiceCatalog> => {
  const db = drizzle(database)
  return Layer.succeed(
    ServiceCatalog,
    ServiceCatalog.of({
      services: makeRepository(db, services, ServiceFromRow),
      providers: makeRepository(db, providers, ProviderFromRow),
      resources: makeRepository(db, resources, ResourceFromRow),
      businessHours: makeRepository(db, businessHours, BusinessHoursFromRow),
      closures: makeRepository(db, closures, ClosureFromRow),
      providerAbsences: makeRepository(db, providerAbsences, ProviderAbsenceFromRow),
    }),
  )
}
