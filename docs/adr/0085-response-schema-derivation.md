# ADR-0085: Response-side wire schemas via Effect Schema + drift property test

- Status: accepted
- Date: 2026-05-24
- Refines: ADR-0078 (OpenAPI derivation from boundary schemas) and
  ADR-0083 (OpenAPI-derived web client types) — closes the loop
  on the **response side** of the wire surface. Request bodies
  and queries flow from `boundarySchemas.ts`; this ADR adds the
  symmetric flow for responses (Ticket, ProjectionEntry, success
  envelopes) so the OpenAPI document itself is no longer the
  bottleneck of hand-written shapes.
- Builds on: ADR-0082 (router auto-generation) — `routerRegistry`
  already takes the request side schema-driven; this ADR removes
  the last hand-written wire shape in `openapi.ts`.

## Context

ADR-0083 made the web client derive its TypeScript types from the
published `docs/openapi.json`. That closed the **client side** of
the schema-driven contract. The **server side** was still
asymmetric:

- Request bodies / queries: derived through
  `boundarySchemas.ts` → `openapiRegistry.ts#bodySchemaFor` →
  inlined into `openapi.ts` path stanzas. Adding a new shape is
  one entry in `boundaryRegistry`.
- Response shapes: hand-written JSON Schema literals in
  `openapi.ts` —
  `TICKET_SCHEMA_INLINE` (40+ lines), `PROJECTION_ENTRY_SCHEMA`,
  `TICKET_ENVELOPE`, `ISSUE_TICKET_MERGED_ENVELOPE`. The
  `Ticket` shape duplicates `packages/core/src/domain/queue/
  Ticket.ts`, which is the canonical Effect Schema the Durable
  Object actually serialises through. Three-way drift between
  the domain schema, the hand-written JSON Schema, and the
  generated web type was the same hazard ADR-0083 set out to
  remove — it was simply living on a different floor.

The right destination was "derive the response shapes the same
way request shapes are derived." A 30-min spike confirmed the
direction was viable but that one mechanism wedge had to be
solved first: `Schema.toJsonSchemaDocument` runs a structural
dedup that rewrites `{ type: "string" }` fields as
`{ $ref: "#/$defs/Instant" }` once any field in the schema refers
to `InstantSchema`. The domain `Ticket` union references `Instant`
through `issuedAt`, `appointmentAt`, `checkedInAt`, `calledAt`,
`overdueAt`, `servedAt`, `markedAt`, `cancelledAt`, `lastNudgedAt`
— ten times across the union — and the dedup runs over a
threshold that does not fire for the boundary schemas (which
reference `Instant` once or twice each). The bug surfaces at
DRAFT level (not just OpenAPI 3.1 conversion), so a Schema-AST
pre-collapse of the union (Strategy D) hits the same wall.

## Decision

A new file `apps/default/src/server/http/responseSchemas.ts`
declares the wire image of `Ticket` and `ProjectionEntry` and
their success envelopes as **Effect Schemas authored by hand**.
They feed through the same `Schema.toJsonSchemaDocument` →
`JsonSchema.toMultiDocumentOpenApi3_1` pipeline that powers the
boundary registry, lift into `components.schemas`, and are `$ref`'d
from every path stanza that returns a ticket.

Three points where this differs from a literal "derive from the
domain `TicketSchema`" implementation:

1. **The wire schema is hand-written, not AST-derived from
   `TicketSchema`.** The dedup bug above made automated derivation
   unsafe inside Effect's current shipping behaviour. The cost is
   that adding a new ticket field requires touching two files
   (`Ticket.ts` and `responseSchemas.ts`) instead of one. The
   benefit is that the wire shape gains a property test gate that
   makes drift fail loudly (next point).
2. **`responseSchemas.drift.test.ts` is the drift detector.**
   Six fixtures (one per `Ticket` variant — Waiting, Called,
   Overdue, Served, NoShow, Cancelled) are encoded through the
   domain `TicketSchema`, JSON-serialised, and decoded through
   `WireTicketSchema`. If a domain variant grows a field the wire
   schema doesn't carry, the decode fails. The fixtures are
   type-annotated with each variant's `Schema.Schema.Type`, so
   the TypeScript compiler also flags a missing-field fixture
   regression at the next field addition.
3. **`Instant`-typed fields are declared as plain `Schema.String`
   in the wire schema, not as `InstantSchema`.** This dodges the
   dedup bug entirely (the wire schema has zero `$defs/Instant`
   references, so the structural-dedup heuristic never fires). The
   wire receives an ISO-8601 string already (the domain encode
   step has flattened `Temporal.Instant` to its `toString()`
   output); the runtime parse back to `Temporal.Instant` happens
   in core's `InstantSchema.decodeTo` and is unrelated to the
   wire-side documentation.

`openapi.ts` now imports `bodySchemaFor` and `responseSchemaFor`
from `openapiRegistry.ts`. The `Ticket` / `ProjectionEntry` /
`TicketEnvelope` / `IssueTicketMergedEnvelope` components are
registered through `responseSchemaFor(...)`, and the per-path
response declarations `$ref` them by name (e.g. `200: { content:
{ "application/json": { schema: { $ref:
"#/components/schemas/TicketEnvelope" } } } }`). The ~80 lines of
hand-written `TICKET_SCHEMA_INLINE` and `PROJECTION_ENTRY_SCHEMA`
go away.

## Considered alternatives

1. **AST-walk derivation of `WireTicketSchema` from
   `TicketSchema`.** A pure function that walks the union's
   members, collects common-vs-state-specific fields, and
   constructs a single `Schema.Struct`. Plan-time first
   preference. Rejected after a 30-min spike: the same dedup bug
   fires regardless of whether the input is a union or a
   pre-collapsed struct, as long as the schema references
   `InstantSchema` more than ~3 times. Re-evaluate when the dedup
   bug is fixed upstream — at that point the hand-written wire
   schema can fold into a derivation step and the drift test
   becomes a freebie.
2. **OpenAPI 3.1 `oneOf` for the discriminated union.** Model
   the six states honestly with a `oneOf` schema and a
   discriminator. Rejected for the same reason as the original
   hand-written collapse: `openapi-typescript` would emit a six-
   arm TS discriminated union that every `apps/web` consumer
   would have to narrow at each use site. The intentional
   flat-collapse strategy stays.
3. **Keep `TICKET_SCHEMA_INLINE` as hand-written JSON Schema and
   add a property test that decodes domain `Ticket` fixtures
   against it.** Same drift safety as the chosen approach but
   keeps the wire shape outside the Effect Schema universe (no
   IDE completion, no Effect refinement constraints, no
   composition with the request side). Rejected on aesthetics:
   one of the goals of the ADR is to bring response shapes onto
   the same `Schema` deck the rest of the wire surface lives on.
4. **Add `additionalProperties: true` to the wire schema via an
   Effect annotation.** Attempted; the current `Schema.Struct`
   API does not surface an annotation slot that
   `toJsonSchemaDocument` honours. The wire schemas ship with
   `additionalProperties: false` — `openapi-typescript` consumes
   types only, so the runtime impact is nil. Polish backlog
   item; revisit when Effect exposes a JSON-Schema annotation
   surface.

## Consequences

**Positive:**

- The response side of the wire surface is now Effect-Schema-
  driven end-to-end. Adding a new response shape (e.g. a
  `BatchResultEnvelope`) is one entry in `responseRegistry` and
  one `$ref` in the path stanza, mirroring how request shapes
  evolve under ADR-0078.
- Three-way drift between domain `Ticket`, `openapi.json`, and
  the generated web `Ticket` type now has two independent
  guards: the on-disk pin (ADR-0083) catches accidental
  `openapi.ts` desync, and `responseSchemas.drift.test.ts`
  catches domain-side field additions that didn't propagate to
  the wire schema.
- `openapi.ts` shrinks by ~80 lines of hand-written JSON Schema.
  Reviews of new endpoints stop wading through that boilerplate.

**Negative / accepted costs:**

- The wire schema and the domain schema are independent files.
  Field additions require touching both — typecheck + drift test
  catch the omission, but the discipline is the developer's. The
  ADR notes that this duplication is the price of dodging the
  Effect dedup bug; it folds away when that bug is fixed.
- Wire-side `Schema.String` for instant fields means the wire
  schema does not constrain the ISO-8601 format at parse time.
  The domain layer is the authority on `Temporal.Instant.from`
  acceptance; the wire side accepts any string. This matches the
  current hand-written behaviour, which also did not constrain
  the format beyond `"string"`.

**Polish backlog (intentional follow-ups, not blockers):**

- `additionalProperties: true` for `Ticket` (forward-compat
  hint to OpenAPI tools). Needs Effect to expose an annotation
  slot `toJsonSchemaDocument` honours.
- `Schema.Int.check(Schema.greaterThanOrEqualTo(1))` for `seq`
  / `displaySeq` minimum constraints. Needs the corresponding
  numeric check API.
- Future automatic derivation: once the Effect dedup bug ships
  a fix, fold `responseSchemas.ts` into a function that walks
  `TicketSchema` and returns the collapsed wire shape. The
  drift test stays as a regression net.

## Verification

- `pnpm --filter default run test:fast` covers
  `responseSchemas.drift.test.ts` (6 cases — one per ticket
  variant) and the on-disk pin from ADR-0083.
- `pnpm --filter default run openapi:write` regenerates
  `docs/openapi.json`; the resulting `components.schemas` carries
  `Ticket`, `ProjectionEntry`, `TicketEnvelope`,
  `IssueTicketMergedEnvelope` derived from `responseSchemas.ts`.
- `pnpm --filter web run openapi:gen && pnpm --filter web run
  typecheck` confirms the regenerated web types stay compatible
  with `apps/web/src/lib/api.ts` consumers.
