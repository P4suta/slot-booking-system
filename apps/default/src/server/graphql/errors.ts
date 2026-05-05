import type { ErrorSeverity } from "@booking/core"

/**
 * Phase 0.7-β4 — typed GraphQL error class. The DurableObject's RPC
 * `Either<EncodedDomainError, EncodedResult>` lifts onto this Error
 * subclass at the resolver boundary, where the `@pothos/plugin-errors`
 * plugin renders it as a typed union arm in the GraphQL schema. Clients
 * see `__typename: "BookingError"` plus the structured payload, never
 * a plain `errors[]` blob (the legacy `throw new GraphQLError` path is
 * gone).
 *
 * The fields mirror `errorToGraphQLPayload` in the core derive helper:
 * `tag` is the `_tag` discriminator, `code` is the stable
 * `E_*` literal, `severity` routes to operator dashboards,
 * `i18nKey` lets the frontend pick the localized message without
 * repeating the catalog.
 */
export type EncodedDomainError = {
  readonly _tag: string
  readonly code: string
  readonly severity: ErrorSeverity
}

export class BookingError extends Error {
  readonly tag: string
  readonly code: string
  readonly severity: ErrorSeverity
  readonly i18nKey: string

  constructor(payload: EncodedDomainError) {
    super(`${payload._tag} (${payload.code})`)
    this.name = "BookingError"
    this.tag = payload._tag
    this.code = payload.code
    this.severity = payload.severity
    this.i18nKey = `error.${payload._tag}`
  }
}
