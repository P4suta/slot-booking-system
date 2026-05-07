import { Clock, Effect } from "effect"
import { codeOf, type DomainError, severityOf } from "../../domain/errors/Errors.js"

/**
 * Phase 2.6 / BI-9 — OTel semconv carrier built on Effect's native
 * `Tracer`. The runtime's own active-span FiberRef is the carrier
 * (introducing a parallel `Telemetry` Context.Tag would shadow it
 * and break propagation across forked children); these helpers are
 * pure derivations that read `Effect.currentSpan` and project
 * domain errors onto the OTel `error.*` semantic-convention
 * attribute set.
 *
 * Why no `@opentelemetry/api` import here: `packages/core` stays
 * runtime-agnostic. The Cloudflare Workers entry (`apps/default`)
 * provides the `TracerProvider` via `@microlabs/otel-cf-workers`'s
 * `instrument(...)` wrap; everything below speaks Effect's
 * tracer abstraction. ADR-0010 (forbidden constructs) is preserved.
 *
 * The boundary cost: `Effect.currentSpan` fails with
 * `NoSuchElementException` when no span is active (e.g. tests that
 * skip the worker entry). Each helper below pipes through
 * `Effect.ignoreLogged` so a missing span is a no-op rather than a
 * defect — the trace just lacks the optional attribute set.
 */

/**
 * Open a span scoped to the inner effect. Type signature is
 * preserved — the outer Effect's `A`, `E`, `R` flow through, and
 * the span ends automatically on the inner effect's completion or
 * interruption.
 */
export const withSpan = <A, E, R>(
  name: string,
  attributes: Readonly<Record<string, unknown>>,
  inner: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.withSpan(name, { attributes })(inner)

/**
 * Add attributes to the active span. Safe to call when no span
 * exists — the runtime's `annotateCurrentSpan` is a no-op when the
 * span ref is unset.
 */
export const addAttributes = (attrs: Readonly<Record<string, unknown>>): Effect.Effect<void> =>
  Effect.annotateCurrentSpan(attrs)

/**
 * Project a `DomainError` onto OTel semconv `error.*` attributes
 * and raise an `exception` event on the active span — Phase 2.6
 * BI-9 derivation point. Every concrete error class carries its
 * `code` + `severity` statics on the leaf class (Phase 2.0 / BI-2);
 * this function is the *only* boundary that materialises them as
 * OTel attributes, mirroring how `errorToGraphQLPayload` is the
 * only boundary for the GraphQL surface (`derivations.ts`).
 *
 * Adding a new `Schema.TaggedError` to the registry forces the
 * `code`/`severity` statics by type-check, which means the OTel
 * attributes are auto-populated with **zero manual catalogue
 * synchronisation** — one taxonomy, three projections (log, GraphQL,
 * trace).
 */
export const recordTaggedError = (e: DomainError): Effect.Effect<void> =>
  Effect.flatMap(Effect.currentSpan, (span) =>
    Effect.flatMap(Clock.currentTimeNanos, (nanos) =>
      Effect.sync(() => {
        span.attribute("error.type", e._tag)
        span.attribute("error.code", codeOf(e))
        span.attribute("error.severity", severityOf(e))
        span.event("exception", nanos, {
          "exception.type": e._tag,
          "exception.message": codeOf(e),
        })
      }),
    ),
  ).pipe(Effect.ignoreLogged)

/**
 * Convenience: chain `recordTaggedError` onto an Effect's failure
 * channel without disturbing the success path. Lifts the BI-9
 * derivation onto the call site with one operator instead of an
 * explicit `Effect.tapError`.
 */
export const tapTaggedError = <A, R>(
  eff: Effect.Effect<A, DomainError, R>,
): Effect.Effect<A, DomainError, R> => Effect.tapError(eff, (e) => recordTaggedError(e))
