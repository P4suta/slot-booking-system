import type { Temporal } from "@js-temporal/polyfill"
import type { ClosureId } from "../types/EntityId.js"

export type Closure = {
  readonly id: ClosureId
  readonly date: Temporal.PlainDate
  readonly reason: string
}
