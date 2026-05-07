# ADR-0041 — GraphQL functor migration (Pothos → derive/graphql.ts)

## Status

Phase 3 PR#7. **M16 landed** (Schema → GraphQLType functor primitive).
**M17–M19 deferred** to a dedicated session that can run an
introspection-SDL byte-equal diff harness; the migration is a
stepping refactor of ~1100 LoC across four resolver files and the
risk of subtly breaking the `apps/web` `gql.tada` client without
tooling-grade verification is high.

## Context

Phase 2.9 confirmed the Pothos PoC PASS finding: `@pothos/core@4.12`
plus `@pothos/plugin-errors@4.9` are Effect-4 compatible and work
correctly inside the existing `apps/default` stack. Pothos has,
however, two structural costs that the Phase 3 plan flagged for
removal:

1. **Code-first DSL with hand-written shape generics.** Each
   resolver file declares `builder.objectRef<Shape>("Name").implement(...)`,
   where `Shape` is a `WireShape<Schema.Codec.Encoded<typeof FromRow>>`
   — a TS-only translation that has to be spelled out in parallel to
   the schema declaration. The "Schema is the source of truth"
   principle (ADR-0036) is then locally violated by the Pothos
   shape generic.
2. **Errors-plugin coupling.** `@pothos/plugin-errors` decorates
   each resolver with `errors: { types: [BookingError] }`, which is
   a non-portable surface the codebase pays for at every field.

Replacing Pothos with a pure functor `Schema → GraphQLType` lets the
GraphQL adapter consume the same Schema annotations the rest of the
read path already drives.

## Decision

### M16 — committed in this ADR

`apps/default/src/server/graphql/derive.ts` provides
`schemaToGraphQLOutputType(schema, { name?, registry? })`, a
structurally-recursive functor on `SchemaAST.AST` covering the
variants the booking domain currently exposes through GraphQL:

- scalar leaves (`String`, `Number`, `Boolean`, `Literal`)
- `Arrays` → `GraphQLList(GraphQLNonNull(...))`
- `Objects` → named `GraphQLObjectType` (with `registry` dedupe so
  recursive / mutually-referential schemas resolve cleanly)
- `Union` of string-`Literal`s → `GraphQLEnumType`

Out of scope for the M16 land:

- `Union` of structs (discriminated unions need a `GraphQLUnionType`
  wrapper that selects per-record `__typename`)
- Custom scalars (PlainDate / Instant / PhoneLast4) — the existing
  Pothos `scalarType` registrations still live in `builder.ts`

### M17–M19 — deferred

Acceptance criteria for the deferred migration session:

1. `apps/default/openapi/graphql.schema.graphql` (introduced by
   PR#8 M23) is captured as the **gold** SDL artefact while the
   codebase is still on Pothos.
2. The migration replaces `builder.ts` + four resolver files with
   `schemaToGraphQLOutputType` + raw `graphql-js`
   `GraphQLObjectType` constructions for: catalog (read), staff
   catalog (read+write), available-slots (read+token-mint),
   mutations (HoldSlot / ConfirmBooking / CancelBooking /
   RescheduleBooking / NoShow / Complete).
3. The **post-migration** `graphql.schema.graphql` is byte-equal to
   the pre-migration gold.
4. `gql.tada`-driven `apps/web` typegen passes against the post-
   migration SDL with no diff in `graphql-env.d.ts`.
5. `@pothos/core` + `@pothos/plugin-errors` removed from
   `apps/default/package.json`.

The autonomous Phase 3 session that delivered M16 lacked the
introspection-diff harness needed to satisfy criterion 3 — running
the migration without that harness is unsafe (gql.tada client
breakage is a remote-detected regression with no fast feedback).

## Consequences

### Positive

- The Schema → GraphQLType functor is committed and tested. Any
  resolver that already speaks `Schema.Codec.Encoded<...>` shapes
  can plug into the new translator on demand.
- The migration path is now an executable plan with explicit gates,
  not a hand-wave.

### Negative

- `apps/default/package.json` keeps `@pothos/core` /
  `@pothos/plugin-errors` until the migration session runs.
- Two object-graph constructions live side-by-side once the
  migration starts (Pothos for legacy resolvers, derive/ for new
  ones). The migration session should **flip** all four resolver
  files in one PR to avoid the side-by-side window expanding.

## References

- ADR-0036 (Schema as Source of Truth)
- ADR-0040 (Bipartite slot matching) — sibling Phase 3 deferred-
  upgrade pattern
- `apps/default/src/server/graphql/derive.ts` — M16 implementation
- `apps/default/test/graphql/derive.test.ts` — M16 verification
