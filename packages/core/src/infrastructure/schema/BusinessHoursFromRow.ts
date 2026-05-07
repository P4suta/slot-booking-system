import { BusinessHoursSchema } from "../../domain/entities/BusinessHours.js"
import { entityFromRow } from "./entityFromRow.js"
import { businessHours } from "./tables/businessHours.js"

/**
 * `BusinessHours` ↔ `business_hours` row codec. The `windows` column
 * is `text(... { mode: "json" })` typed as
 * `{ start: string; end: string }[]` — `BusinessHoursSchema.Encoded`'s
 * windows are the same shape (PlainTime ↔ "HH:MM:SS" handled inside
 * `OpenWindowSchema`'s codec).
 */
export const BusinessHoursFromRow = entityFromRow({
  table: businessHours,
  domain: BusinessHoursSchema,
})
