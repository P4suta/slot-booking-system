# ADR-0083: OpenAPI-derived web client types

- Status: accepted
- Date: 2026-05-24
- Refines: ADR-0078 (OpenAPI derivation from boundary schemas) —
  closes the loop on the server-side schema-driven contract by
  pulling the published artefact into the web client.
- Builds on: ADR-0082 (router auto-generation from boundary
  registry) — the action-dispatch endpoints now flow through a
  single declarative registry, so the OpenAPI document is the
  single source of every wire shape the web client consumes.

## Context

`apps/web/src/lib/api.ts` declared every domain type the customer
and staff UIs need — `Ticket`, `Lane`, `SlotEntry`,
`ProjectionEntry`, `ShopState`, `StaffShopState` — by hand. The
declarations matched the server-side schema **at the time they
were written**; nothing prevented drift.

The friction was structural rather than typo-driven. Three places
encoded the same shape independently:

1. `packages/core/src/domain/queue/Ticket.ts` — the canonical
   Effect Schema (`TicketSchema`) that the Durable Object
   serialises through.
2. `apps/default/src/server/http/openapi.ts` —
   `TICKET_SCHEMA_INLINE` (JSON Schema) that documents the wire
   format for OpenAPI consumers.
3. `apps/web/src/lib/api.ts` — the hand-typed `Ticket` interface
   the SvelteKit UI binds to.

Any time `Ticket` evolved (the `Overdue` state + `nudgeCount` in
ADR-0072, the global `displaySeq` in ADR-0080, the `merged` field
in ADR-0069), all three locations needed an aligned update — or
some subset shipped first and the others rotted. The
[[feedback-shape-shifting-endpoint-guard]] memory captures one
recent symptom: the `/api/v1/queue` endpoint returns two
different shapes based on the `x-staff-token` header, and the web
client had to wrap response handling in runtime shape guards
because the type system didn't know which arm landed.

ADR-0076 and ADR-0078 already moved the server side to
schema-driven derivation. ADR-0082 closed the routing reflex.
This ADR closes the **client-side type** reflex: the web client
should consume the same OpenAPI document the server publishes,
generated mechanically rather than transcribed by hand.

## Decision

The web client's wire types are now derived end-to-end:

1. **`apps/default/scripts/write-openapi-json.ts`** is a small
   tsx runner that imports `openApiDocument` and writes the
   serialised JSON to `docs/openapi.json`. Wired as
   `pnpm --filter default run openapi:write`.
2. **`docs/openapi.json` is committed to the repository.**
   It is the published artefact every downstream consumer reads —
   the web client codegen, an external OpenAPI explorer, the
   audit trail in pull-request diffs. The artefact is not
   regenerated on every web build; the developer regenerates
   when `openapi.ts` / `boundarySchemas.ts` /
   `openapiRegistry.ts` change.
3. **`apps/default/test/server/http/openapi-on-disk.test.ts`**
   is a drift detector. It re-serialises `openApiDocument` and
   compares to the committed file, failing CI with a
   regeneration-hint message if the developer forgot to run
   `openapi:write`. Same pattern as the existing
   `openapiRegistry.test.ts` count pin.
4. **`apps/web/src/generated/openapi.d.ts`** is produced by
   `openapi-typescript` (committed alongside the paraglide
   output). Wired as `pnpm --filter web run openapi:gen`; the
   web `codegen` script chains paraglide and openapi:gen so
   `pnpm run dev` / `build` / `check` regenerate both
   automatically.
5. **`apps/web/src/lib/api.ts`** imports `Ticket`, `Lane`,
   `SlotEntry`, and the request-body shape for `POST /tickets`
   from the generated module. Functions and the `ApiResult`
   wrapper stay hand-written; only the type aliases moved.

The `Ticket` shape is lifted into `components.schemas.Ticket` on
the server (a small refactor of `openapi.ts`) so the generated
TypeScript exposes a single `Ticket` alias rather than re-deriving
the same shape for every endpoint that returns one. The
`IssueTicket` idempotent-merge envelope (`merged: true`) is now
documented in the OpenAPI document — previously inline-only at
the dispatcher — so the generated response type matches what the
server actually emits.

`openapi-typescript` is invoked with `--immutable --root-types
--root-types-no-schema-prefix` so the generated module exports
`readonly`-everywhere types and surface-level aliases (`export
type Ticket = components['schemas']['Ticket']`) directly.

## Considered alternatives

1. **Direct schema import from `@booking/core`.** Share
   `TicketSchema` and the boundary schemas from a single
   `@booking/wire` package consumed by both apps. Rejected —
   the boundary schemas live in `apps/default` because they
   model the HTTP-side normalisation step (NFKC kana, last-4
   digits, etc.) which is wire-only. Lifting them into core
   couples domain types to wire concerns; importing from
   `apps/default` would be an anti-pattern. OpenAPI is the
   honest interchange boundary.
2. **Runtime schema generation in the web client.** Have the
   web client fetch `/api/v1/openapi.json` at startup and
   derive types from it. Rejected — build-time codegen catches
   drift at compile time (the entire point of the exercise);
   runtime derivation would push the failure to a 500 response
   the customer can see.
3. **Skip the on-disk artefact, generate JSON during web
   build.** Have `apps/web`'s build invoke `pnpm --filter
   default run openapi:write` as a step. Rejected — couples
   web's build to apps/default being type-checkable, which is a
   regression of CI scoping. The committed artefact also makes
   schema diffs visible in PR review, which is the same
   rationale paraglide uses for committing `src/paraglide/`.

The two web-side aliases that **stay manual** (and the reason
why):

- `ShopState` (anonymous `/api/v1/queue` shape) and
  `StaffShopState` (staff variant with PII). Modelling the
  shape-shifting via `x-staff-token` in OpenAPI 3.1 requires
  either `oneOf` with a header-discriminator extension (not
  standard) or splitting into two endpoints. Either is a
  separate, ADR-sized decision; for now the two aliases stay
  hand-written and are flagged in the api.ts header.
- `ProjectionEntry` / `OverdueProjectionEntry`. Anonymous-shape
  projection items. Same rationale as `ShopState` — they're a
  facet of the shape-shifting `/queue` response.

When the `/queue` endpoint is upgraded (or split into two paths
with explicit response shapes), these aliases can flow through
the generated module and the api.ts header annotation goes away.

## Consequences

**Positive:**

- Three-way drift between core schema / OpenAPI document / web
  type is structurally impossible for everything the codegen
  reaches. A breaking change on the server surfaces as a
  TypeScript error in `apps/web` on the next codegen run.
- New endpoints land as one PR touching: the `QueueAction`
  variant, the boundary schema, the routing registry entry
  (ADR-0082), and one `openapi.ts` path stanza. The web client
  picks them up automatically by re-running `openapi:gen`.
- `docs/openapi.json` doubles as the published spec for external
  consumers (mobile apps, alternative dashboards, support
  tooling).
- The on-disk drift detector closes the loop: a stale artefact
  is a CI failure with a one-command fix, not a silent
  divergence.

**Negative / accepted:**

- One more committed file (`docs/openapi.json`, ~76 KB) and one
  generated file (`apps/web/src/generated/openapi.d.ts`, ~80
  KB). Both diff cleanly when the underlying schemas change.
- `openapi-typescript` adds a devDependency to `apps/web`. The
  package is widely-used and zero-runtime (pure types), so the
  bundle stays unchanged.
- Generated types don't perfectly express variant unions — the
  Ticket shape is a flat object with optional state-specific
  fields. Consumers narrow by `state` at the call site, matching
  the wire reality. A future ADR could lift the schema into
  `oneOf` discriminated variants if the narrowing becomes a
  recurring pain point.

**Out of scope:**

- Modelling the shape-shifting `/queue` endpoint in OpenAPI
  (see above; tracked separately).
- Generating runtime validators on the client. `ApiResult`
  pattern-matches on response envelope shape; full schema
  validation is a performance trade-off the client doesn't need
  given the server validates inputs at the boundary.
- Mobile or external clients consuming `docs/openapi.json`.
  Their codegen flows are downstream and out of this ADR's
  scope.

## Implementation

Touched paths:

- **`apps/default/scripts/write-openapi-json.ts`** — new.
  tsx runner; writes `docs/openapi.json` from
  `openApiDocument`.
- **`apps/default/package.json`** — new `openapi:write` script.
- **`apps/default/src/server/http/openapi.ts`** —
  `TICKET_SCHEMA_INLINE` lifted into
  `components.schemas.Ticket`; envelopes use
  `{ $ref: "#/components/schemas/Ticket" }`. New
  `ISSUE_TICKET_MERGED_ENVELOPE` documents `merged: true`. The
  `Ticket` required-list now includes `freeText`,
  `appointmentAt`, `checkedInAt` (always present on the wire,
  may be `null`), matching the domain invariant in
  `packages/core/src/domain/queue/Ticket.ts`.
- **`apps/default/test/server/http/openapi-on-disk.test.ts`** —
  new. Drift detector with a regeneration-hint failure
  message.
- **`docs/openapi.json`** — new (committed). 76 KB JSON.
- **`apps/web/package.json`** — `openapi-typescript` added to
  devDependencies; new `openapi:gen` script; `codegen` chains
  paraglide + openapi:gen so `dev` / `build` / `check`
  regenerate both.
- **`apps/web/src/generated/openapi.d.ts`** — new (committed).
  Auto-generated; never hand-edited.
- **`apps/web/src/lib/api.ts`** — `Ticket`, `Lane`, `SlotEntry`,
  and the `IssueTicket` body shape now import from
  `../generated/openapi.js`. `issueTicket` return type carries
  `merged?: true`. `ShopState` / `StaffShopState` /
  `ProjectionEntry` annotated as intentionally manual until the
  `/queue` endpoint is upgraded.
- **`biome.json`** — `docs/openapi.json`,
  `apps/web/src/generated` excluded from biome checks
  (generated; do not hand-format).

Adversarial probes (the existing test suite is the regression
detector):

- Edit `TICKET_SCHEMA_INLINE` to add a field; rerun the test
  suite; `openapi-on-disk.test.ts` fails with the
  regeneration hint until `pnpm --filter default run
  openapi:write` is run.
- Change `IssueTicketBodySchema` in `boundarySchemas.ts`;
  rerun web `tsc --noEmit`; the change propagates as a
  TypeScript error wherever `issueTicket(...)` is called with
  the now-incompatible argument shape.
- Remove a path from `openapi.ts`; rerun web `tsc`; usages of
  the now-deleted shape (`paths["/.../..."]`) fail to
  compile.

Migration policy:

- Server-side schema change → `openapi:write` → commit
  `docs/openapi.json` → in apps/web, `openapi:gen` →
  commit `apps/web/src/generated/openapi.d.ts`. Three
  commits or one, but the artefact diffs ship together.
- Web client uses generated types for everything the OpenAPI
  document covers; for shapes outside its scope (the
  shape-shifting `/queue` endpoint), the manual annotations in
  `api.ts` are deliberately marked so the audit trail of
  "still manual" is visible.
