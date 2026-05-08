import { Clock, Effect } from "effect"
import { codeOf, type DomainError, severityOf } from "../../domain/errors/Errors.js"

/**
 * OTel semconv carrier built on Effect's native `Tracer`. The runtime's
 * own active-span FiberRef is the carrier; these helpers are pure
 * derivations that read `Effect.currentSpan` and project domain errors
 * onto OTel `error.*` semantic-convention attributes.
 *
 * `packages/core` stays runtime-agnostic; the Cloudflare Workers entry
 * provides the `TracerProvider` via `@microlabs/otel-cf-workers`'s
 * `instrument(...)` wrap. `Effect.currentSpan` fails with
 * `NoSuchElementException` when no span is active, so each helper
 * pipes through `Effect.ignoreLogged` (missing span = no-op).
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
 * Project a `DomainError` onto OTel semconv `error.*` attributes and
 * raise an `exception` event on the active span. Every error class
 * carries its `code` / `severity` statics on the leaf type, so adding
 * a new `Schema.TaggedError` to the registry auto-populates the OTel
 * attributes by type-check — zero manual catalogue synchronisation.
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
  ).pipe(Effect.ignore)

/**
 * Chain `recordTaggedError` onto an Effect's failure channel without
 * disturbing the success path.
 */
export const tapTaggedError = <A, R>(
  eff: Effect.Effect<A, DomainError, R>,
): Effect.Effect<A, DomainError, R> => Effect.tapError(eff, (e) => recordTaggedError(e))
