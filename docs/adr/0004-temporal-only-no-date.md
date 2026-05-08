# 0004. Time = `Temporal` only; `Date` is forbidden

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: domain, correctness

## Context

`Date` mutates, parses ambiguously, conflates instants with civil dates, and refuses to model time zones explicitly. Every reservation system that uses `Date` eventually mishandles a DST transition or a midnight boundary.

## Decision

- Persist instants as ISO 8601 strings in UTC (`Temporal.Instant.toString()`).
- Use `@js-temporal/polyfill` until the V8 / Workers runtime ships native `Temporal` everywhere we run.
- Operate on civil times with `Temporal.PlainDate`, `Temporal.PlainTime`, `Temporal.ZonedDateTime`. The deployment time zone is configured per app and threaded through application layer ports.
- The deployment time zone identifier is a brand: `BusinessTimeZone & string`. Functions that take a `BusinessTimeZone` cannot accidentally receive a stringly-typed `"UTC"` literal.
- For sort and range queries on D1, persist a redundant `instant_epoch_ms` INTEGER column alongside the canonical ISO string.
- `new Date(...)`, `Date.now()`, `Date.parse(...)` are forbidden in `packages/core/src/**` and `apps/*/src/**`. Enforced by ripgrep in CI.

## Consequences

- DST and time-zone arithmetic become explicit at type level.
- Polyfill cost (~30 KB minified) is paid once; tree-shaken away from edge bundles where possible.
- Migration to native `Temporal` in the future is a polyfill-removal — no API change.

## Alternatives considered

- **`Date` + `date-fns-tz`**: still leaves `Date` as the lingua franca, which decays as soon as any helper is missed.
- **Luxon**: own model, large bundle, predates `Temporal`. Strictly worse than the standard.
- **String manipulation**: lethal at edge cases.

## References

- SYSTEM.md §4.4, §7.11.
- TC39 `Temporal` proposal (Stage 4).
