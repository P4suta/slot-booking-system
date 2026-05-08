import type { Table } from "drizzle-orm"
import { createSelectSchema } from "drizzle-orm/effect-schema"
import { Schema, SchemaGetter } from "effect"

/**
 * BI-10 SoT factor: lift a Drizzle table into the Effect codec ecosystem
 * by overlaying the entity's domain Schema on top of the table-derived
 * row Schema.
 *
 * The architectural shape is `R → D` via `Schema.decodeTo(domain, overlay)`:
 *
 *   - **Row world `R`** is `Schema.Codec<RowEncoded, RowEncoded>`,
 *     produced by `createSelectSchema(table)`. The encoded form is
 *     `table.$inferSelect`: every JSON column comes back as the
 *     `$type<...>()`-narrowed array, every `mode: "boolean"` column
 *     comes back as `boolean`, every text column as `string`.
 *
 *   - **Domain world `D`** is `Schema.Codec<Entity, DomainEncoded>` —
 *     the domain Schema whose Encoded form may differ from the row
 *     (e.g. `Set` vs `readonly string[]` when the domain models a Set
 *     but the SQL column is JSON array).
 *
 *   - **Overlay** provides the structural decoder/encoder pair when
 *     `R.Type` and `D.Encoded` aren't structurally identical.
 *     Optional — when the row columns directly match the domain's
 *     encoded shape (the typical case once `Temporal` / brand
 *     transformations live inside the domain Schema), pass nothing.
 *
 * Categorically: `R` and `D` form a **reflective subcategory** with
 * `R` at the encoded-side identity (`Type === Encoded`) and `D`
 * carrying the refinement to the domain Type. The overlay realises
 * the adjunction; the round-trip `Type → Encoded → Type` is verified
 * by property test (`schemaToArbitrary`).
 */
export const entityFromRow = <Entity, DomainEncoded, RowEncoded = DomainEncoded>(args: {
  readonly table: Table
  readonly domain: Schema.Codec<Entity, DomainEncoded>
  readonly overlay?: {
    readonly decode: (row: RowEncoded) => DomainEncoded
    readonly encode: (encoded: DomainEncoded) => RowEncoded
  }
}): Schema.Codec<Entity, RowEncoded> => {
  const rowCodec = createSelectSchema(args.table) as unknown as Schema.Codec<RowEncoded>
  if (args.overlay === undefined) {
    return rowCodec.pipe(Schema.decodeTo(args.domain))
  }
  const overlay = args.overlay
  return rowCodec.pipe(
    Schema.decodeTo(args.domain, {
      decode: SchemaGetter.transform(overlay.decode),
      encode: SchemaGetter.transform(overlay.encode),
    }),
  )
}
