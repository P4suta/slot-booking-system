# ADR-0041 — GraphQL functor migration (Pothos → derive/graphql.ts)

## Status

Phase 3 PR#7. **Accepted** — M16/M17/M18/M19/M20 landed.

## Context

Phase 2.9 confirmed the Pothos PoC PASS finding: `@pothos/core@4.12`
plus `@pothos/plugin-errors@4.9` are Effect-4 compatible and work
correctly inside the existing `apps/default` stack. Pothos has,
however, two structural costs that the Phase 3 plan flagged for
removal:

1. **Code-first DSL with hand-written shape generics.** Each
   resolver file declared `builder.objectRef<Shape>("Name").implement(...)`,
   where `Shape` was a `WireShape<Schema.Codec.Encoded<typeof FromRow>>`
   — a TS-only translation that had to be spelled out in parallel to
   the schema declaration. The "Schema is the source of truth"
   principle (ADR-0036) was then locally violated by the Pothos
   shape generic.
2. **Errors-plugin coupling.** `@pothos/plugin-errors` decorated
   each resolver with `errors: { types: [BookingError] }`, a non-
   portable surface the codebase paid for at every field.

Replacing Pothos with raw `graphql-js` constructions driven by the
codebase's own primitives lets the GraphQL adapter consume the same
Effect Schema annotations the rest of the read path already drives.

## Decision

### M16 — Schema → GraphQLOutputType functor (`derive.ts`)

`apps/default/src/server/graphql/derive.ts` provides
`schemaToGraphQLOutputType(schema, { name?, registry?, fieldNullability? })`,
a structurally-recursive functor on `SchemaAST.AST` covering the
variants the booking domain currently exposes through GraphQL:

- scalar leaves (`String`, `Number`, `Boolean`, `Literal`)
- `Arrays` → `GraphQLList(GraphQLNonNull(...))` (list-element non-
  null wrap mirrors `Schema.Array(NonNullable)`)
- `Objects` → named `GraphQLObjectType` (with `registry` dedupe so
  recursive / mutually-referential schemas resolve cleanly)
- `Union` of string-`Literal`s → `GraphQLEnumType`
- `fieldNullability` policy parameter — default `"nullable"` matches
  the Pothos baseline, opt-in `"nonNull"` exposes the strict-Schema
  reading

### M17 — Resolver primitives (`resolver.ts`)

`apps/default/src/server/graphql/resolver.ts` carries the pieces the
functor cannot derive:

- `errorEnvelope({ verb, inner, args, body, registry })` — the verb-
  indexed combinator that projects `Result<BookingError, A>` onto the
  GraphQL category. Mints `Mutation<Verb>Success { data: A! }` and
  `Mutation<Verb>Result = BookingError | Mutation<Verb>Success` once
  per verb, threaded through a shared `ErrorEnvelopeRegistry`. The
  resolver wrapper catches a thrown `BookingError`, wraps it into a
  brand-tagged plain envelope (graphql-js short-circuits any returned
  `Error` instance into a field error in `completeValue`, so the
  raw class cannot be returned), and `resolveType` discriminates the
  union arm via a `Symbol.for(...)` brand that survives cross-realm
  module loads.
- `bookingErrorType` — the shared `BookingError` GraphQL object (5
  nullable string fields, unchanged wire shape).
- Three identity-passthrough custom scalars (`PlainDate`, `Instant`,
  `PhoneLast4`) and the four-literal `BookingSource` enum.

### M18+M19 — Resolver cutover

Each resolver module exports a field-record factory that returns
`Record<string, GraphQLFieldConfig<unknown, GraphQLContext>>`:

- `resolvers/catalog.ts` — six read queries, six entity output types.
  `Service` / `Provider` / `Resource` are plain-scalar structs;
  `Closure` / `ProviderAbsence` use the custom `PlainDate` /
  `Instant` scalars; `BusinessHours` carries a named nested
  `OpenWindow` struct. All hand-rolled because the M16 functor does
  not yet detect `Schema.Int` annotations or brand-as-scalar (see
  Consequences §"Deferred follow-ups").
- `resolvers/staffCatalog.ts` — twelve mutations + nine
  `GraphQLInputObjectType`s, each mutation wrapped in `errorEnvelope`.
- `resolvers/mutations.ts` — four booking mutations
  (HoldSlot / ConfirmBooking / CancelBooking / RescheduleBooking),
  also wrapped in `errorEnvelope`.
- `resolvers/availableSlots.ts` — the `availableSlots` query and the
  `AvailableSlot` output object.

`schema.ts` instantiates a single `ErrorEnvelopeRegistry`, spreads
the four factories into `Query` / `Mutation` root objects, and runs
the result through `lexicographicSortSchema` — the same alphabetical
normalisation Pothos's `builder.toSchema()` applied internally. The
registry parameter on `types: [...]` pins the BookingError type, the
booking-source enum, and the three scalars so they appear in the
printed SDL even when reachable only through union arms.

`GraphQLContext` lifts out of the deleted `builder.ts` into
`context.ts` so resolvers and yoga consume it without Pothos
vocabulary as a middle step.

`apps/default/test/graphql/sdlByteEqual.test.ts` reads
`apps/default/schema.graphql` from disk and asserts
`printSchema(schema) + "\n"` is byte-equal — the regression net inside
the standard `pnpm test` loop.

### M20 — Pothos removal

`@pothos/core` and `@pothos/plugin-errors` removed from
`apps/default/package.json`; lockfile regenerated (`pnpm install
--no-frozen-lockfile`). No other dep changes; the lockfile diff is
exactly the two Pothos sub-trees and their resolution entries.

## Acceptance — verified

1. `apps/default/schema.graphql` is byte-equal pre/post-migration
   (`git diff --exit-code apps/default/schema.graphql` succeeds after
   `pnpm print-schema`).
2. `apps/web/src/graphql-env.d.ts` is byte-equal pre/post-migration —
   the `gql.tada` typegen is unaffected.
3. `apps/default/test/graphql/sdlByteEqual.test.ts` passes (15 total
   apps/default vitest cases green).
4. `tsc -b`, biome `--error-on-warnings`, eslint `--max-warnings 0`,
   depcruise (0 violations), packages/core vitest (578 cases green),
   type-coverage (99.58%) all green.
5. `apps/default/src/` no longer imports `@pothos/*`; the dependency
   tree is Pothos-free.

## Consequences

### Positive

- The Schema → GraphQLType functor is committed and tested, with an
  explicit nullability policy parameter that documents the tension
  between gold-SDL byte-equal and strict-Schema reading.
- The 16 mutation envelopes are realised as a single combinator
  (`errorEnvelope`); resolver bodies reduce to
  `(args, ctx) => Promise<EncodedInner>` and the verb-indexed naming
  is the categorical identity for the projection.
- `apps/default/package.json` is two dependencies lighter; the
  `BookingError` JS class lives entirely inside the codebase (no
  external errors-plugin coupling).

### Negative

- The catalog read types (Service / Provider / Resource / etc.) are
  hand-rolled rather than functor-derived because the M16 functor
  cannot yet emit `GraphQLInt` for `Schema.Number.check(Schema.isInt())`
  filters or map `Schema.brand("PlainDate", ...)` to a custom scalar.
  The hand-rolled construction means schema changes (e.g. adding a
  new column to `services`) require a second edit in
  `resolvers/catalog.ts`; the SoT principle is maintained at the row
  codec level but not at the GraphQL output type level.

### Deferred follow-ups (recorded for future PRs)

1. **Functor `Schema.Int` annotation detection** — inspect the AST's
   filter annotations and emit `GraphQLInt` instead of `GraphQLFloat`
   when `Schema.isInt()` is present. Lets `Service` / `Provider` /
   `Resource` move from hand-rolled to functor-derived.
2. **Brand-aware scalars** — recognise `Schema.brand("PlainDate", ...)`
   etc. and emit a corresponding custom scalar with the Schema's own
   decode/encode at `parseValue` / `serialize`. Pushes parse-on-decode
   to the GraphQL boundary (the `InvalidPhoneLast4Error` etc. would
   surface as scalar-coercion errors instead of use-case failures).
3. **`Schema.TaggedUnion` of structs → `GraphQLUnionType`** — the
   M16 land was scoped to unions of string literals (→ enum). Lifting
   the envelope itself to a Schema combinator (`Schema.Result<E, A>`)
   and projecting it through the functor would replace `errorEnvelope`
   as a TS-side helper with a Schema-side construction. Strictly
   architecturally more elegant; deferred because every use case
   would need to re-type its output as a Schema, scope creep beyond
   PR#7's byte-equal mandate.
4. **`schemaToGraphQLInputType`** — the dual functor for input types
   (`GraphQLInputObjectType`). The 9 input types in
   `resolvers/staffCatalog.ts` are hand-rolled because there is no
   Effect Schema for `ServiceInput` (the optional `id` and the
   `requiredSkills.values` indirection are GraphQL-side conveniences).
   Worth revisiting once (1) and (2) reduce the gap.
5. **Schema-faithful nullability** — flip `derive.ts`
   `fieldNullability` from `"nullable"` to `"nonNull"` and update
   clients. Strictly more informative SDL; intentionally breaking,
   coordinated with apps/web typegen refresh.

## References

- ADR-0036 (Schema as Source of Truth)
- ADR-0040 (Bipartite slot matching) — sibling Phase 3 deferred-
  upgrade pattern
- `apps/default/src/server/graphql/derive.ts` — M16 functor
- `apps/default/src/server/graphql/resolver.ts` — M17 envelope +
  scalars + enum + BookingError type
- `apps/default/src/server/graphql/{schema,context}.ts` — M18+M19
  schema assembly
- `apps/default/src/server/graphql/resolvers/*.ts` — M18+M19 resolver
  cutover
- `apps/default/test/graphql/{derive,errorEnvelope,sdlByteEqual}.test.ts`
  — verification
