# ADR-0043 — ErrorRedaction port

## Status

Phase 3 PR#8. **Accepted** — landed alongside the DX hardening
commit train (commit 3 of plan `validated-stargazing-karp.md`). The
GraphQL adapter consumes the dev/prod redactor pair directly via
`devRedactCause` / `prodRedactCause`; future Effect-runtime callers
(structured logger, audit writer) consume via the
`ErrorRedaction` port.

## Context

`runRpcOrThrow` (commit 1) finally surfaces the `RpcClientError`
cause to the structured log sink, but the operator-facing GraphQL
response still has only `__typename` / `code` / `severity` /
`i18nKey` (`errorToGraphQLPayload`, ADR-0017). When the cause is
something like `DataCloneError: Could not serialize object of type
"Object"`, the operator has to chain `traceparent` → log query →
search log to recover the message. In dev, that is friction; in
prod, intentionally so (ADR-0017 keeps internal causes off the
wire).

The wire boundary therefore needs an env-indexed redactor: pass the
useful cause shape in dev, return identity-zero in prod. Two
constraints frame the design:

1. **ADR-0017 invariant**: the `cause` field on a TaggedError class
   is restricted to `Storage` errors. Widening that contract to
   include arbitrary causes on the GraphQL surface would force
   every error type to carry `cause` upstream — an ergonomics
   regression and a category mistake (the wire-side preview is a
   different concern from the in-memory error class shape).
2. **ADR-0041 invariant**: SDL byte-equal must survive. The
   serialiser must not extend the schema's syntactic surface.

## Decision

Introduce an `ErrorRedaction` port:

```ts
class ErrorRedaction extends Context.Service<
  ErrorRedaction,
  { readonly redact: (cause: unknown) => Record<string, unknown> }
>()("@booking/core/ErrorRedaction") {}
```

Plus the matching env-indexed adapter `ErrorRedactionLive` that
selects between two pure functions based on the resolved
{@link RuntimeMode} (ADR-0042):

- `devRedactCause` — `Error → { name, message, stack[0..3], originalTag? }`
- `prodRedactCause` — `_ → {}` (categorical terminal object)

The adapter composes via `Layer.unwrap(Effect.gen(...))`, the
canonical `Reader RuntimeMode (Layer ErrorRedaction)` lift.

The two redactor implementations are exported standalone from the
same module so synchronous adapters (graphql-yoga's plugin chain,
which does not run inside the Effect runtime) can reuse the
canonical definition without an `Effect.runSync` ceremony. The
duplication-by-reference keeps both call sites — the Effect-runtime
caller via the port, and the yoga plugin via direct import — pinned
to one source of truth.

`errorToGraphQLPayload` stays unchanged in
`packages/core/src/domain/errors/derivations.ts:53`. A new sibling,
`errorToGraphQLExtensions(cause, redact)`, derives the extensions
payload as a pure function:

```ts
export const errorToGraphQLExtensions = (
  cause: unknown,
  redact: (cause: unknown) => Record<string, unknown>,
): Record<string, unknown> => {
  if (cause === undefined || cause === null) return {}
  const tagged = cause as { readonly _tag?: unknown }
  const originalTag = typeof tagged._tag === "string" ? tagged._tag : undefined
  const causeFields = redact(cause)
  const hasCause = Object.keys(causeFields).length > 0
  return {
    ...(hasCause ? { cause: causeFields } : {}),
    ...(originalTag !== undefined ? { originalTag } : {}),
  }
}
```

The yoga plugin `useDevErrorExtensions` walks `result.errors[]` on
`onExecuteDone`, calls `errorToGraphQLExtensions(err.originalError ??
err, ctx.redactCause)`, and reconstructs each error with the spread
extensions. ADR-0041's SDL invariant is preserved by construction:
`extensions` are wire-only metadata and never appear in the schema's
syntactic surface.

## Consequences

**Wins**:

- The dev / prod cleavage is concentrated in one boolean evaluated
  once at request boot. The GraphQL adapter's wire-side projection
  composes cleanly:
  `errorToGraphQLPayload(e)` (always-on)
  + `errorToGraphQLExtensions(cause, redact)` (env-indexed).
- ADR-0017's "cause is `Storage`-only" invariant is preserved at the
  TaggedError class level. The redactor lives at the wire boundary,
  not on the error class.
- Tests can swap `ErrorRedaction` via `Layer.succeed(ErrorRedaction,
  ErrorRedaction.of({ redact: vi.fn(...) }))` to assert exact wire
  contracts under arbitrary causes.

**Trade-offs**:

- The yoga plugin bypasses the port and reads `IS_DEV` directly to
  pick the redactor (synchronous boundary, no Effect runtime). The
  duplication is one boolean and pinned to the same exported
  functions, so divergence cannot occur silently — but a future
  contributor adding a third redactor mode would have to update both
  the port adapter and the yoga selection. Documented at
  `redactorFor(env)` site in `apps/default/src/server/graphql/yoga.ts`.
- `errorToGraphQLExtensions` returns `Record<string, unknown>`; the
  weak typing reflects the heterogeneous shape (the redactor's
  output is opaque to the derivation). Tests anchor the contract
  shape per branch.

## Alternatives considered

1. **Widen `errorToGraphQLPayload`** to take a redactor parameter.
   Rejected because the always-on payload (`code` / `severity` /
   `i18nKey`) and the env-indexed extensions (`cause` / `originalTag`)
   serve different audiences (frontend i18n vs. operator triage) and
   should compose, not bundle.
2. **Add `cause` field to every TaggedError** so it's available
   when the resolver throws. Rejected — direct violation of
   ADR-0017's "cause is `Storage`-only" rule, and would push
   wire-side concerns into the domain layer.
3. **Resolve the redactor inside `onExecuteDone` via `Effect.runSync`
   on `ErrorRedaction`**. Rejected because graphql-yoga's hook is
   sync on a hot path; spinning up an Effect runtime per
   `onExecuteDone` adds latency without functional benefit. The
   shared exported pair (`devRedactCause` / `prodRedactCause`) gets
   us the same single-source-of-truth without the runtime cost.

## References

- ADR-0017 — TaggedError + cause discipline (preserved here)
- ADR-0026 — Logger / Clock port philosophy (mirrored)
- ADR-0041 — graphql-functor migration / SDL byte-equal (preserved)
- ADR-0042 — RuntimeMode port (the dispatcher this port consumes)
