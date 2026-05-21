# ADR-0078: OpenAPI derived from Effect.Schema boundary registry

- Status: accepted
- Date: 2026-05-22
- Refines: ADR-0019 (Effect.Schema is the boundary-parsing standard)
- Tags: architecture · http · effect

## Context

`boundarySchemas.ts` is the canonical declaration of every HTTP
wire shape the queue router decodes (`IssueTicketBody`,
`MyTicketQuery`, `PushSubscriptionBody`, …). The companion file
`openapi.ts` re-states the same shapes as hand-written JSON
Schema objects so the `/api/v1/openapi.json` document can serve
a draft-2020-12 / OpenAPI 3.1 description.

Two surfaces describing the same wire shape is one drift away
from a stale spec — a new property added to
`IssueTicketBodySchema` but missed in `openapi.ts` is exactly
the regression code review catches but lint does not.

Effect 4 beta ships `Schema.toJsonSchemaDocument(schema)` plus
`JsonSchema.toMultiDocumentOpenApi3_1(doc)` adapters. The
project can lift every boundary schema into a JSON Schema /
OpenAPI 3.1 document at runtime, eliminating the duplicate
hand-written shapes.

## Decision

Stage the migration in two steps. **Step 1 (this ADR)** lands
the foundation:

- `apps/default/src/server/http/openapiRegistry.ts` — single
  `boundaryRegistry` map from stable name (`IssueTicketBody`,
  `MyTicketQuery`, …) to the corresponding Effect.Schema. The
  map is the single input every future derive consumer will
  read from.
- `deriveBoundaryJsonSchema(key)` — `Schema.toJsonSchemaDocument`
  invoked on a registry entry. The only call site for that
  function so future drift fixes have one place to touch.
- Test `apps/default/test/server/http/openapiRegistry.test.ts`
  asserts every registry entry derives a valid `type: "object"`
  JSON Schema and that the entry count does not silently shrink.

**Step 2 (follow-up)** replaces the hand-written request-body /
query schemas inside `openapi.ts` with `deriveBoundaryJsonSchema(name)`
calls, plus a golden snapshot test pinning the resulting
`/api/v1/openapi.json` payload. The narrative content (paths,
summaries, tag groupings, security requirements, response
envelopes) stays hand-written because none of it has a
Schema-level analogue.

Step 1 is additive: the existing hand-written `openapi.ts`
keeps serving traffic; the registry merely exists alongside.
A future PR (or the same operator) can do step 2 with no
breaking interim state.

## Consequences

**Easier**:

- New boundary surfaces extend the registry in one line, in
  addition to the existing `boundarySchemas.ts` declaration. No
  hand-coded JSON Schema to maintain alongside.
- `Schema.toJsonSchemaDocument` is invoked from exactly one
  function (`deriveBoundaryJsonSchema`); a future
  schema-feature-not-yet-supported issue surfaces there and
  nowhere else.
- The drift gate is mechanical: the registry test fails if a
  registry entry stops resolving to a `type: "object"` (typo in
  the Schema, accidentally `Schema.Tuple`, …).

**Harder**:

- The two-step migration leaves duplicate descriptions in tree
  until step 2 lands. Reviewers checking the openapi.json output
  still read the hand-written `openapi.ts`; step-1's only
  artefact is the registry plus the test.
- `Schema.toJsonSchemaDocument` carries Effect's own assumptions
  about JSON Schema dialect targets (it emits draft-2020-12).
  The OpenAPI 3.1 path through `JsonSchema.toMultiDocumentOpenApi3_1`
  is required when step 2 happens.

## Alternatives considered

- **`@hono/zod-openapi`.** Zod is a second source of truth that
  conflicts with ADR-0019 (Effect.Schema is THE boundary
  standard). Rejected.
- **Hand-rolled `Schema.AST` re-descender.** ADR-0077's `withSpan`
  precedent shows a small custom traversal can work; rejected
  because Effect now ships `toJsonSchemaDocument` and matching
  the project to upstream is the cheaper long-run play.
- **Skip the openapi document.** Some Workers projects drop the
  schema endpoint entirely. Rejected because ADR-0019 explicitly
  promises an OpenAPI 3.1 surface as a boundary discoverability
  contract.

## References

- `apps/default/src/server/http/openapiRegistry.ts`
- `apps/default/src/server/http/openapi.ts`
- `apps/default/test/server/http/openapiRegistry.test.ts`
- Effect 4 beta: `Schema.toJsonSchemaDocument`, `JsonSchema.toMultiDocumentOpenApi3_1`
- ADR-0019 (Effect.Schema is the boundary-parsing standard)
