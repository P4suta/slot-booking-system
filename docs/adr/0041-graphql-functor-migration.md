# ADR-0041 — GraphQL functor migration (Pothos → derive/graphql.ts)

## Status

Phase 3 PR#7. **Accepted** — M16/M17/M18/M19/M20/M21/M22/M23/M24/M25/M26 landed.
No deferred follow-ups.

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

Initial structurally-recursive functor on `SchemaAST.AST` covering
scalars / arrays / objects / enum-from-string-literals.

### M17 — Resolver primitives (`resolver.ts`)

`errorEnvelope({ verb, inner, args, body, registry })` — the verb-
indexed combinator that projects `Result<BookingError, A>` onto the
GraphQL category. Mints `Mutation<Verb>Success { data: A! }` and
`Mutation<Verb>Result = BookingError | Mutation<Verb>Success` once
per verb. Plus `bookingErrorType`, three identity-passthrough custom
scalars (PlainDate / Instant / PhoneLast4), and the `BookingSource`
enum.

### M18+M19 — Resolver cutover

Each resolver module exports a field-record factory; `schema.ts`
spreads them into `Query` / `Mutation` root objects through a shared
`ErrorEnvelopeRegistry` and runs the result through
`lexicographicSortSchema`. `GraphQLContext` lifts out of the deleted
`builder.ts` into `context.ts`.

### M20 — Pothos removal

`@pothos/core` and `@pothos/plugin-errors` removed from
`apps/default/package.json`; lockfile regenerated.

### M21–M26 — Functor closure (no remaining "deferred")

All architectural follow-ups originally tagged for a later phase land
as part of this PR:

- **M21** — `Schema.Number.check(Schema.isInt())` detection. The
  `Number` AST case walks `ast.checks` and emits `GraphQLInt` when any
  filter carries `meta._tag === "isInt"`, falling back to
  `GraphQLFloat`. Six new resolver-side schemas use this directly
  (`Schema.Number.check(Schema.isInt())` for integer-bound input
  fields).
- **M22** — Brand-aware scalar mapping. `DeriveOptions.scalarRegistry:
  Map<string, GraphQLScalarType>` maps an AST whose resolved brands
  include a registered identifier to the pre-built scalar. Effect's
  `resolve` rule (last check's annotations falls through to ast
  annotations) makes brands attached after a check pipe still
  surface. Used by `AvailableSlotWireSchema.start/end` (brand
  `"Instant"` → `instantScalar`).
- **M23** — `Schema.Union` of `_tag`-discriminated structs lifts to
  `GraphQLUnionType` with `resolveType` reading the `_tag` field.
  Each member object type registers under `<UnionName>_<Tag>` for
  byte-stable SDL printing.
- **M24** — `schemaToGraphQLInputType` dual functor on the same
  source category, lifting `Objects → GraphQLInputObjectType` and
  rejecting unions of structs (GraphQL forbids them in input
  positions). Inputs are always schema-faithful: `Schema.optional`
  fields stay nullable, the rest wrap in `GraphQLNonNull`. Drives
  the nine `*Input` types in `resolvers/staffCatalog.ts`
  (`SkillListInputSchema` / `OpenWindowInputSchema` /
  `ServiceInputSchema` / etc.).
- **M25** — Resolver wiring. `bookingResultType`,
  `availableSlotType`, `catalogMutationResultType`, and the nine
  staff catalog inputs are all built via the functor from local
  `Schema.Struct` sources annotated with `identifier`. The catalog
  read types (Service / Provider / Resource / BusinessHours /
  Closure / ProviderAbsence) stay hand-rolled — not because the
  functor lacks a feature, but because the row codec ASTs go through
  `drizzle-orm/effect-schema`'s `createSelectSchema`, which lowers
  `text(... mode: "json")` columns to plain `Schema.String` rather
  than the JSON-decoded array shape (an upstream limitation, not a
  PR#7 deferral).
- **M26** — Schema-faithful nullability flip. The
  `fieldNullability` default flips from `"nullable"` to
  `"schema-faithful"`; required Schema fields land as
  `GraphQLNonNull`, `Schema.optional` fields stay nullable. The two
  prior policies (`"nullable"`, `"nonNull"`) remain available as
  opt-in for callers that need uniform reading. The `BookingError`
  GraphQL type's five fields, the `BookingResult` / AvailableSlot /
  CatalogMutationResult fields, and every catalog read type all
  surface as `String!` / `Int!` / `Boolean!` / `<Scalar>!` after the
  flip — the SDL becomes strictly more informative without losing
  any field. The `apps/web` `gql.tada` typegen regenerates
  automatically and `tsc -b` passes against the new typings.

### Identifier annotation as fallback name

The functor reads `ast.annotations.identifier` as a fallback name
hint when no caller-supplied `name` is passed. `OpenWindowSchema`
in `packages/core/src/domain/entities/OpenWindow.ts` and the nine
input schemas in `resolvers/staffCatalog.ts` use this so nested
struct ASTs surface as named GraphQL types rather than as
`AnonymousStruct`. Same mechanism the OpenAPI functor in
`packages/core/src/derive/openapi.ts` consumes through the shared
predicate algebra, so `derive/graphql` and `derive/openapi` stay
aligned.

## Acceptance — verified

1. `apps/default/schema.graphql` regenerates correctly via
   `pnpm print-schema`. Schema-faithful nullability is intentional —
   the SDL is strictly more informative than the Pothos baseline; no
   field is lost.
2. `apps/web/src/graphql-env.d.ts` regenerates via `pnpm graphql-env`.
   `tsc -b` over the workspace passes against the new typings — the
   apps/web TS code compiles cleanly with the more-informative output
   types.
3. `apps/default/test/graphql/sdlByteEqual.test.ts` passes (the gold
   artefact is the regenerated SDL, kept in sync by the codegen
   step in lefthook pre-push).
4. 16 vitest cases verify the functor's coverage end-to-end (output
   path: scalar / brand / Int / array / struct / nullability policies
   / TaggedUnion / dedupe; input path: leaves / struct with optional
   fields / dedupe / brand mapping). Plus 6 errorEnvelope cases. All
   31 apps/default vitest cases green.
5. `tsc -b`, biome `--error-on-warnings`, eslint `--max-warnings 0`,
   depcruise (0 violations), packages/core vitest (578 cases green),
   type-coverage (≥99.5%) all green. Knip's only flag is the
   pre-existing `HealthResponseSchema` baseline, untouched by PR#7.
6. `apps/default/src/` no longer imports `@pothos/*`; the dependency
   tree is Pothos-free.

## Consequences

### Positive

- The Schema → GraphQLType twin functor (output + input) is the
  resolver layer's single source of truth. Adding a column to a
  Schema-driven shape propagates through `schemaToGraphQL*Type`
  without per-resolver edits.
- The 16 mutation envelopes are realised as a single combinator
  (`errorEnvelope`); resolver bodies reduce to
  `(args, ctx) => Promise<EncodedInner>` and the verb-indexed naming
  is the categorical identity for the projection.
- Schema-faithful nullability propagates Schema's required/optional
  distinction to the GraphQL wire — clients receive types that
  reflect the actual shape rather than the Pothos baseline's
  uniform-nullable default.
- `apps/default/package.json` is two dependencies lighter; the
  `BookingError` JS class lives entirely inside the codebase (no
  external errors-plugin coupling).

### Negative

- The catalog read types remain hand-rolled because of the
  `drizzle-orm/effect-schema` JSON-column lowering. Schema changes
  for those entities require a second edit in
  `resolvers/catalog.ts` until the upstream gap closes (drizzle
  emitting `Schema.Array(Schema.String)` for `text(... mode: "json")
  .$type<readonly string[]>()` columns rather than `Schema.String`).
  Tracked separately from PR#7.

## References

- ADR-0036 (Schema as Source of Truth)
- ADR-0040 (Bipartite slot matching) — sibling Phase 3 deferred-
  upgrade pattern
- `apps/default/src/server/graphql/derive.ts` — twin functor
- `apps/default/src/server/graphql/resolver.ts` — envelope combinator
  + scalars + enum + BookingError type
- `apps/default/src/server/graphql/{schema,context}.ts` — schema
  assembly
- `apps/default/src/server/graphql/resolvers/*.ts` — Schema-driven
  resolver field factories
- `apps/default/test/graphql/{derive,errorEnvelope,sdlByteEqual}.test.ts`
  — verification
