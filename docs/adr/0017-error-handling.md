# 0017. Errors as `Data.TaggedError` classes with codes, causes, and meta

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: errors, observability

## Context

Phase 0 had a flat tagged-union `DomainError = { _tag: "..."; reason: ... }`
which was sufficient for parser-level signalling but starves operators
of debugging information once the system enters production: there is
no stable error code, no severity, no trace correlation, no cause
chain, and `instanceof` does not work. We need an error model that
serves three audiences at once:

1. **Code**: pattern-match on `_tag` (compile-time exhaustive).
2. **Operators**: stable codes, severity, structured payloads, cause
   chains for root-cause analysis.
3. **API consumers**: stable codes, no leaked PII, deterministic
   classification of validation vs domain errors.

## Decision

Adopt **Effect's `Data.TaggedError`** as the base class for every
domain error. Each tag has its own concrete class:

```ts
class InvalidPhoneLast4Error extends Data.TaggedError("InvalidPhoneLast4")<{
  readonly reason: string
  readonly meta?: ErrorMeta
}> {}
```

This gives us, automatically:

- `_tag` (the discriminator),
- `name` / `message` / `stack` (Error-shaped, useful in dev tools),
- `instanceof` narrowing,
- compatibility with Effect's error channel (`Effect.fail(new …Error(…))`).

### Stable error codes

Each tag maps to a stable code via `errors/codes.ts`:

- `E_VAL_*` for boundary validation failures.
- `E_DOM_*` for business-rule violations.
- `E_INFRA_*` reserved for Phase 1 (Cloudflare bindings).

The `ErrorTag` union and the `TABLE` mapping are defined in the same
file; adding a new tag requires extending both, and TypeScript's
exhaustiveness check rejects any tag without a code.

### Metadata via `withMeta`

```ts
const errored = withMeta(new BookingNotFoundError({}), {
  traceId,
  context: { bookingCode: "ABCD-EFG" },
  cause: lowLevelError,
})
```

`ErrorMeta` carries:

- `traceId: TraceId` — request correlation. ULID-shaped brand.
- `context: Record<string, unknown>` — operator-facing key/value bag,
  used for entity ids, parameters, deployment metadata. **Never PII.**
- `cause: unknown` — underlying error preserved through the chain.

### Log payload

`toLogPayload(err)` produces a plain object suitable for the structured
logger sink (ADR-0009). It strips Error-prototype noise (no stack
trace, no class methods) and reduces `cause` to `{ name, message }` so
inner stacks never escape into logs.

PII-safety is structural: errors only carry IDs, codes, and operator
reason strings; the `pii-guard` CI job rejects any source that adds
field names like `nameKana` / `phoneLast4` / `freeText` / `email` /
`address` / `birthday` / `gender`.

### Construction

Every error is constructed by `new XxxError({…})`. The class itself is
the "smart constructor": payload typing is enforced at the call site.
There is no separate factory function layer — call sites read

```ts
return Either.left(new InvalidBookingCodeError({ reason: "wrong-length" }))
```

…which keeps the error type, payload shape, and class-instance
identity in one place. `_tag`-based narrowing and `instanceof` both
work.

### Top-level alias

`errors/Errors.ts` exports `DomainError = ValidationError | DomainRuleError`
as the canonical union; `ValidationError` and `DomainRuleError` are
the two layered subsets so callers can constrain return types
narrowly when appropriate.

## Consequences

- Every error is loggable, code-able, and inspectable at the same
  level of detail in dev and in production.
- Operators get cause chains for root-cause analysis without polluting
  log sinks with stack traces.
- Adding a new error: declare a class, add a row in `codes.ts`, add a
  smart-constructor in `DomainError.ts`. CI catches missing codes.
- `instanceof` narrowing is available; some style guides flag this in
  preference of `_tag` discrimination — both are acceptable here, but
  `_tag` is preferred for serialised contexts.

## Alternatives considered

- **Plain tagged objects** (the previous approach): no `instanceof`, no
  cause chain, no stack trace. Adequate for the parser layer but not
  for operator observability.
- **A monolithic `class BookingError extends Error`** with a `tag`
  field: lacks the per-tag payload typing.
- **`@effect/schema`'s `Schema.TaggedClass`**: works but couples the
  domain layer to Effect Schema, which we reserve for boundary parsing.

## References

- ADR-0009 (logging-PII discipline).
- ADR-0010 (forbidden constructs — `throw` is not used; errors travel
  as Either / Effect channel values).
- Effect docs: `Data.TaggedError`.
