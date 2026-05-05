import { Temporal } from "@js-temporal/polyfill"
import { Either, Schema } from "effect"
import { type DomainError, InvalidAbsenceError } from "../errors/Errors.js"
import { ProviderAbsenceIdSchema, ProviderIdSchema } from "../types/EntityId.js"
import { InstantSchema } from "../types/Temporal.js"
import { type Comparator, intervalSmartCtor } from "../value-objects/Interval.js"

export const ProviderAbsenceSchema = Schema.Struct({
  id: ProviderAbsenceIdSchema,
  providerId: ProviderIdSchema,
  start: InstantSchema,
  end: InstantSchema,
  reason: Schema.String,
})
export type ProviderAbsence = Schema.Schema.Type<typeof ProviderAbsenceSchema>

// Narrow `Temporal.Instant.compare` overloads onto a strict-Instant
// comparator so the smart constructor's `T` cannot widen.
const cmpInstant: Comparator<Temporal.Instant> = (a, b) => Temporal.Instant.compare(a, b)

const makeAbsenceInterval = intervalSmartCtor<Temporal.Instant, DomainError>(
  cmpInstant,
  () => new InvalidAbsenceError({ reason: "absence start must precede end" }),
)

export const makeProviderAbsence = (params: {
  readonly id: ProviderAbsence["id"]
  readonly providerId: ProviderAbsence["providerId"]
  readonly start: Temporal.Instant
  readonly end: Temporal.Instant
  readonly reason: string
}): Either.Either<ProviderAbsence, DomainError> =>
  Either.map(makeAbsenceInterval(params.start, params.end), (interval) => ({
    id: params.id,
    providerId: params.providerId,
    start: interval.start,
    end: interval.end,
    reason: params.reason,
  }))
