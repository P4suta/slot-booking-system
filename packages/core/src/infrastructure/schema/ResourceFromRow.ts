import { ResourceSchema } from "../../domain/entities/Resource.js"
import { entityFromRow } from "./entityFromRow.js"
import { resources } from "./tables/resources.js"

/**
 * `Resource` ↔ `resources` row codec. See `entityFromRow` for the
 * structural design (compose via `row.Type === domain.Encoded`).
 */
export const ResourceFromRow = entityFromRow({ table: resources, domain: ResourceSchema })
