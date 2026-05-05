import { Temporal } from "@js-temporal/polyfill"
import { Either, Schema } from "effect"
import { type DomainError, InvalidAbsenceError } from "../errors/Errors.js"
import { ProviderAbsenceIdSchema, ProviderIdSchema } from "../types/EntityId.js"
import { InstantSchema } from "../types/Temporal.js"

export const ProviderAbsenceSchema = Schema.Struct({
  id: ProviderAbsenceIdSchema,
  providerId: ProviderIdSchema,
  start: InstantSchema,
  end: InstantSchema,
  reason: Schema.String,
})
export type ProviderAbsence = Schema.Schema.Type<typeof ProviderAbsenceSchema>

export const makeProviderAbsence = (params: {
  readonly id: ProviderAbsence["id"]
  readonly providerId: ProviderAbsence["providerId"]
  readonly start: Temporal.Instant
  readonly end: Temporal.Instant
  readonly reason: string
}): Either.Either<ProviderAbsence, DomainError> => {
  if (Temporal.Instant.compare(params.start, params.end) >= 0) {
    return Either.left(new InvalidAbsenceError({ reason: "absence start must precede end" }))
  }
  return Either.right({ ...params })
}
