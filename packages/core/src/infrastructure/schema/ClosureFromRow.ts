import { ClosureSchema } from "../../domain/entities/Closure.js"
import { entityFromRow } from "./entityFromRow.js"
import { closures } from "./tables/closures.js"

/**
 * `Closure` ↔ `closures` row codec. The `date` column is `text` and
 * `ClosureSchema.Encoded.date` is `string` (the PlainDate ↔ ISO
 * conversion lives inside `PlainDateSchema`'s codec).
 */
export const ClosureFromRow = entityFromRow({ table: closures, domain: ClosureSchema })
