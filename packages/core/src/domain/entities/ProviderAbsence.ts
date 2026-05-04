import { Temporal } from "@js-temporal/polyfill"
import { Either } from "effect"
import { type DomainError, InvalidAbsenceError } from "../errors/Errors.js"
import type { ProviderAbsenceId, ProviderId } from "../types/EntityId.js"

export type ProviderAbsence = {
  readonly id: ProviderAbsenceId
  readonly providerId: ProviderId
  readonly start: Temporal.Instant
  readonly end: Temporal.Instant
  readonly reason: string
}

export const makeProviderAbsence = (params: {
  readonly id: ProviderAbsenceId
  readonly providerId: ProviderId
  readonly start: Temporal.Instant
  readonly end: Temporal.Instant
  readonly reason: string
}): Either.Either<ProviderAbsence, DomainError> => {
  if (Temporal.Instant.compare(params.start, params.end) >= 0) {
    return Either.left(new InvalidAbsenceError({ reason: "absence start must precede end" }))
  }
  return Either.right({ ...params })
}
