import type { ErrorSeverity, GraphQLErrorPayload } from "@booking/core"

/**
 * Phase 0.7-β4 — typed GraphQL error class. The DurableObject's RPC
 * `Result<DomainError, …>` lifts onto this Error subclass at the
 * resolver boundary, where the `@pothos/plugin-errors` plugin renders
 * it as a typed union arm in the GraphQL schema. Clients see
 * `__typename: "BookingError"` plus the structured payload, never a
 * plain `errors[]` blob.
 *
 * The constructor input is the canonical {@link GraphQLErrorPayload}
 * minted by `errorToGraphQLPayload` in core (`derivations.ts`); the
 * class is now a thin wire-shape carrier rather than a parallel field
 * copy of the core derivation. `tag` keeps its old name for backwards
 * compatibility with the GraphQL field but reads from `__typename` —
 * one source for both wire surfaces.
 */
export class BookingError extends Error {
  readonly tag: string
  readonly code: string
  readonly severity: ErrorSeverity
  readonly i18nKey: string

  constructor(payload: GraphQLErrorPayload) {
    super(`${payload.__typename} (${payload.code})`)
    this.name = "BookingError"
    this.tag = payload.__typename
    this.code = payload.code
    this.severity = payload.severity
    this.i18nKey = payload.i18nKey
  }
}
