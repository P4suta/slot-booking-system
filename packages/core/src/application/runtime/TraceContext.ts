import { Effect, FiberRef } from "effect"
import { ulid } from "ulidx"
import { parseTraceId, type TraceId } from "../../domain/errors/TraceId.js"

/**
 * Request-scoped `TraceId` carrier. The Worker entry point seeds the
 * FiberRef when it receives a request (e.g. from a `traceparent`
 * header or by minting a fresh ULID); use cases / loggers / audit
 * writers read the same FiberRef so a single request's chain shares
 * one trace id end-to-end without threading it through every
 * function signature.
 *
 * The fork-inherit semantics of `FiberRef.make` mean concurrent
 * sub-effects see the same value automatically — no manual
 * `Effect.locally(traceId, …)` wrapping needed for the common case.
 *
 * Why FiberRef over `Context.Tag`: the trace id is **inherited by
 * every forked child fiber** without being redeclared in each
 * sub-effect's `R` channel; a `Tag` would force every leaf to list
 * `TraceContext` in its requirements. The FiberRef pattern matches
 * Effect's idiomatic carrier for cross-cutting context (it is the
 * shape `Effect.runtime` itself uses for `currentSpan`).
 */
export const CurrentTraceId: FiberRef.FiberRef<TraceId | undefined> = FiberRef.unsafeMake<
  TraceId | undefined
>(undefined)

/**
 * Read the current trace id, or return undefined when no request
 * context has been attached. Sinks (logger, audit) call this to
 * decorate emitted payloads.
 */
export const getCurrentTraceId: Effect.Effect<TraceId | undefined> = FiberRef.get(CurrentTraceId)

/**
 * Run an Effect with a specific trace id pinned. The carrier is
 * scoped to the inner Effect; on exit, the FiberRef restores the
 * outer value (or resets to undefined at the root).
 */
export const withTraceId = <A, E, R>(
  traceId: TraceId,
  inner: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.locally(inner, CurrentTraceId, traceId)

/**
 * Mint a fresh request-scoped `TraceId` from a freshly-generated
 * Crockford ULID. ulidx is total within its alphabet, so
 * `parseTraceId` here never fails on its output; the throw is the
 * boundary that records the assumption.
 */
export const mintTraceId = (): TraceId => {
  const raw = ulid()
  const r = parseTraceId(raw)
  /* c8 ignore next 1 — defensive branch: ulidx output is total for the parser */
  if (r._tag === "Left") throw new Error(`mintTraceId: ulidx produced a non-TraceId value: ${raw}`)
  return r.right
}
