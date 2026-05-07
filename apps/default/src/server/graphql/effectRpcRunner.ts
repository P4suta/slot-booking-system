import { type DomainError, errorToGraphQLPayload } from "@booking/core"
import { Effect, Result } from "effect"
import { BookingError } from "./errors.js"

/**
 * Phase 2.8 / BI-4 — adapter that runs an `effect/unstable/rpc` client
 * program inside a GraphQL resolver, narrowing the typed `DomainError`
 * channel onto the Pothos errors plugin's `BookingError` envelope.
 *
 * The transport-level error channel from `RpcClient.makeNoSerialization`
 * is `RpcClientError` (network / dispatch failures); the application
 * channel is the project's own `DomainError` union (Phase 2.0 / BI-2
 * `Schema.TaggedError` registry). On the client side the two collapse
 * into a single `Effect.Effect<A, DomainError | RpcClientError>` —
 * this helper distinguishes them by the discriminator.
 *
 * Both arms route through the same {@link BookingError} envelope,
 * which carries the canonical {@link errorToGraphQLPayload} shape from
 * core — the only place that knows how a `DomainError` projects onto a
 * GraphQL field response. The transport synthetic stays local because
 * it isn't a `DomainError` (no registry entry, no `_tag` discriminator
 * inside `errorClassRegistry`).
 */
export const runRpcOrThrow = async <A>(
  program: Effect.Effect<
    A,
    DomainError | { readonly _tag: "RpcClientError"; readonly message: string }
  >,
): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(program))
  if (Result.isSuccess(result)) return result.success
  const err = result.failure
  if (err._tag === "RpcClientError") {
    // Synthetic GraphQLErrorPayload — TransportError is a wire-only
    // synthetic (no `errorClassRegistry` entry on this tag).
    throw new BookingError({
      __typename: "TransportError",
      code: "E_INF_TRANSPORT",
      severity: "infrastructure",
      i18nKey: "error.TransportError" as never,
    })
  }
  throw new BookingError(errorToGraphQLPayload(err))
}
