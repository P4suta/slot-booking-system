import { Schema } from "effect"
import { ClosureIdSchema } from "../types/EntityId.js"
import { PlainDateSchema } from "../types/Temporal.js"

export const ClosureSchema = Schema.Struct({
  id: ClosureIdSchema,
  date: PlainDateSchema,
  reason: Schema.String,
})
export type Closure = Schema.Schema.Type<typeof ClosureSchema>
