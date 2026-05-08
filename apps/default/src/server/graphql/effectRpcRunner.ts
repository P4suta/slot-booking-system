import { type DomainError, errorToGraphQLPayload, Logger, toLogPayload } from "@booking/core"
import { Effect, Result } from "effect"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { WorkersLoggerLive } from "../adapters/WorkersLoggerLive.js"
import { BookingError } from "./errors.js"

/**
 * Phase 2.8 / BI-4 — adapter that runs an `effect/unstable/rpc` client
 * program inside a GraphQL resolver, narrowing the typed `DomainError`
 * channel onto the graphql-js `BookingError` envelope (ADR-0041).
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
 *
 * Both arms also fan out through {@link Logger} *before* the throw:
 * `RpcClientError.reason` carries the originating `name` / `message`
 * (e.g. `DataCloneError: Could not serialize…`) which would otherwise
 * collapse into the synthetic `TransportError` envelope and disappear.
 * The structured `LogPayload` keeps the operator on the trail.
 */

/**
 * `Effect.tapError`-style operator that emits a structured `LogPayload`
 * for the originating error before re-yielding it. Returns an Effect
 * that requires {@link Logger} so the caller controls the sink (live
 * worker logger in production, mock collector in tests).
 */
export const tapErrorAsRpcOrDomain = <A, R>(
  eff: Effect.Effect<A, DomainError | RpcClientError, R>,
): Effect.Effect<A, DomainError | RpcClientError, R | Logger> =>
  Effect.tapError(eff, (err) =>
    Effect.gen(function* () {
      const logger = yield* Logger
      if (err instanceof RpcClientError) {
        yield* logger.error(rpcClientErrorPayload(err))
      } else {
        yield* logger.error(toLogPayload(err))
      }
    }),
  )

/**
 * Build the synthetic `LogPayload` for a transport-tier failure. The
 * `cause` preview follows the same `{name, message}` shape that
 * `toLogPayload` uses for `Storage` errors (ADR-0017), so log sinks
 * see one uniform field whether the failure originated in the domain
 * or in the wire layer.
 */
const rpcClientErrorPayload = (err: RpcClientError) => {
  const reason = err.reason
  const cause =
    reason._tag === "RpcClientDefect" && reason.cause instanceof Error
      ? { name: reason.cause.name, message: reason.cause.message }
      : undefined
  return {
    _tag: "RpcClientError" as const,
    code: "E_INF_TRANSPORT",
    severity: "infrastructure" as const,
    data: { reason: reason._tag, message: reason.message },
    ...(cause !== undefined ? { cause } : {}),
  }
}

export const runRpcOrThrow = async <A>(
  program: Effect.Effect<A, DomainError | RpcClientError>,
): Promise<A> => {
  const tapped = tapErrorAsRpcOrDomain(program).pipe(Effect.provide(WorkersLoggerLive))
  const result = await Effect.runPromise(Effect.result(tapped))
  if (Result.isSuccess(result)) return result.success
  const err = result.failure
  if (err instanceof RpcClientError) {
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
