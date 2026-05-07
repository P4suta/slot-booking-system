import { codeOf, type DomainError, severityOf } from "@booking/core"
import { Effect, Result } from "effect"
import { BookingError } from "./errors.js"

/**
 * Phase 2.8 / BI-4 — adapter that runs an `effect/unstable/rpc` client program
 * inside a GraphQL resolver, narrowing the typed `DomainError` channel
 * onto the Pothos errors plugin's `BookingError` envelope.
 *
 * The transport-level error channel from `RpcClient.makeNoSerialization`
 * is `RpcClientError` (network / dispatch failures); the application
 * channel is the project's own `DomainError` union (Phase 2.0 / BI-2
 * `Schema.TaggedError` registry). On the client side the two collapse
 * into a single `Effect.Effect<A, DomainError | RpcClientError>` —
 * this helper distinguishes them by the discriminator.
 *
 *   - `instanceof Error` for `DomainError` instances (every
 *     `Schema.TaggedError` subclass extends `Error`).
 *   - `RpcClientError` (`_tag === "RpcClientError"`) is recoded as a
 *     synthetic `BookingError` carrying an `E_INF_TRANSPORT` code so
 *     the resolver surface stays uniform — all errors take the same
 *     shape on the wire.
 *
 * Throwing `BookingError` is what `@pothos/plugin-errors` consumes to
 * render the typed `BookingError` arm of the GraphQL union.
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
    throw new BookingError({
      _tag: "TransportError",
      code: "E_INF_TRANSPORT",
      severity: "infrastructure",
    })
  }
  throw new BookingError({
    _tag: err._tag,
    code: codeOf(err),
    severity: severityOf(err),
  })
}
