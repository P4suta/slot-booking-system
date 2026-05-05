# 0036. Schema as the source of truth + Capability stays first-class

- Status: accepted
- Date: 2026-05-06
- Deciders: Yasunobu
- Tags: schema, derivation, capability, scope

## Context

Phase 0.7's β tier pushed two Schema-related design choices that
deserve being stated explicitly:

1. **Where derived helpers live** — the project ships
   `packages/core/src/derive/` as the single source of truth for
   "Schema → secondary surface" lifts. Two helpers ship today:
   `schemaToArbitrary` (Effect's `Arbitrary.make` re-export) and
   `schemaToCheckConstraint` (regex-pattern → SQLite REGEXP CHECK).
   The Pothos `objectRef` derivation lives in
   `apps/default/src/server/graphql/derive.ts` (planned for Phase
   0.10) because Pothos is an adapter dependency.
2. **Capability as first-class value vs Effect Tag** — the
   alternative is to lift Capability into an `Effect.Tag` so use
   cases require it through the `R` channel. Rejected.

## Decision

### Schema-derived helpers

- Two helpers in `core/derive`: `schemaToArbitrary`,
  `schemaToCheckConstraint`. Future helpers (e.g. JSON Schema for
  OpenAPI export) plug into the same module.
- Pothos `objectRef` derivation lives in the apps layer because
  the dependency direction (`apps/default → @booking/core`) cannot
  reverse. Phase 0.10 will add `derive.ts` to apps/default with
  the `schemaToPothosRef` helper.
- Drizzle column derivation is **not** automated. The Schema →
  SQLite type mapping has too many impedance mismatches (JSON column
  variants, foreign keys, default expressions) to express as a
  generic helper without losing the safety net of explicit column
  definitions. CHECK constraints (above) are the one safe
  derivation.

### Capability stays a value

- Capability lives in `Command.capability: Capability`.
  `apply(booking, command, eventId)` is pure; the Effect runtime
  never sees the capability through `R`.
- Lifting Capability to `Tag` would force every resolver to
  `provideService(Capability, …)`; the wiring complexity (one
  resolver call per request, with a different Capability per
  caller) buys nothing the value form does not already give.
- The `subjectOf(capability)` derivation keeps the audit literal
  (`Booking.cancelledBy` / `BookingEvent.by`) in sync with the
  capability without storing the capability twice.

## Deferred items recorded here

- **DDL one-source-of-truth** — `apps/default/src/server/durableObjects/schema.ts`
  hand-writes the DO DDL alongside the Drizzle table definitions.
  Phase 0.7-γ1 stops at the size-limit gate; a future phase will
  derive the DDL via `drizzle-orm/sqlite-core/getTableConfig`. The
  current duplication is small and any drift fails Miniflare
  integration tests at the next Phase boundary.
- **Miniflare integration test** — Phase 0.7-γ2 covers
  property/fuzz at the domain layer. The Cloudflare-runtime DO +
  alarm + outbox-drain integration test moves to Phase 0.10
  (end-to-end Miniflare) where it joins the customer-flow smoke
  tests.

## Consequences

- The derive helpers shape every future "Schema-driven boundary"
  story; resisting the temptation to over-derive (Drizzle column
  types, anything Pothos) keeps the helper module small.
- Capability remains a single field on Command rather than an
  ambient runtime value; the trade is explicitness for wiring
  freedom.

## References

- ADR-0019 (Effect.Schema boundary codec)
- ADR-0033 (Capability newtype)
- `packages/core/src/derive/index.ts`
- `packages/core/src/domain/auth/Capability.ts`
