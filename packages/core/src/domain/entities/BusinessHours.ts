import type { BusinessHoursId } from "../types/EntityId.js"
import { canonicalize, type OpenWindow } from "./OpenWindow.js"
import type { Weekday } from "./Weekday.js"

/**
 * Open intervals for a single weekday. `windows` is canonicalised
 * (sorted by start, non-overlapping, no zero-length). An empty
 * `windows` array means closed all day for that weekday — distinct
 * from `Closure`, which targets a specific calendar date.
 */
export type BusinessHours = {
  readonly id: BusinessHoursId
  readonly weekday: Weekday
  readonly windows: readonly OpenWindow[]
}

export const makeBusinessHours = (
  id: BusinessHoursId,
  weekday: Weekday,
  windows: readonly OpenWindow[],
): BusinessHours => ({
  id,
  weekday,
  windows: canonicalize(windows),
})
