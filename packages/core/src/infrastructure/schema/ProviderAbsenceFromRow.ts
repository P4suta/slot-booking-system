import { ProviderAbsenceSchema } from "../../domain/entities/ProviderAbsence.js"
import { entityFromRow } from "./entityFromRow.js"
import { providerAbsences } from "./tables/providerAbsences.js"

/**
 * `ProviderAbsence` ↔ `provider_absences` row codec. `start` / `end`
 * columns are `text` carrying ISO Instants — the
 * `ProviderAbsenceSchema.Encoded` shape matches.
 */
export const ProviderAbsenceFromRow = entityFromRow({
  table: providerAbsences,
  domain: ProviderAbsenceSchema,
})
