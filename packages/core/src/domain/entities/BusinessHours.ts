import { Schema } from "effect"
import type { BusinessHoursId } from "../types/EntityId.js"
import { BusinessHoursIdSchema } from "../types/EntityId.js"
import type { OpenWindow } from "./OpenWindow.js"
import { canonicalize, OpenWindowSchema } from "./OpenWindow.js"
import type { Weekday } from "./Weekday.js"
import { WeekdaySchema } from "./Weekday.js"

/**
 * Open intervals for a single weekday. `windows` is canonicalised
 * (sorted by start, non-overlapping, no zero-length). An empty
 * `windows` array means closed all day for that weekday — distinct
 * from `Closure`, which targets a specific calendar date.
 */
export const BusinessHoursSchema = Schema.Struct({
  id: BusinessHoursIdSchema,
  weekday: WeekdaySchema,
  windows: Schema.Array(OpenWindowSchema),
})
export type BusinessHours = Schema.Schema.Type<typeof BusinessHoursSchema>

export const makeBusinessHours = (
  id: BusinessHoursId,
  weekday: Weekday,
  windows: readonly OpenWindow[],
): BusinessHours => ({
  id,
  weekday,
  windows: canonicalize(windows),
})
