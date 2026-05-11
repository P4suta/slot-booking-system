# ADR-0086: Wire types sourced from `@booking/core`

- Status: Accepted (Backfilled 2026-05-12)
- Date: 2026-05-11 (originally landed in commit `e0ba56e`)
- Stage: E / S18
- Refines: ADR-0085 (single-source projection store), ADR-0081
  (CRDT primitives + wire v6)

## Decision

Make `@booking/core` the single owner of every type that
crosses the wire. The web app no longer re-declares
`ShopState` / `StaffShopState` / `ProjectionEntry` /
`FeedMessage` / `VectorClock` shapes in `apps/web/src/lib/api.ts`
— it imports them from the package's published `exports`
sub-paths.

```ts
// apps/web/src/lib/api.ts (post-S18)
import type {
  FeedMessage,
  ProjectionEntry,
  ShopState,
  ShopStateDelta,
  StaffProjectionEntry,
  StaffShopState,
  StaffShopStateDelta,
} from "@booking/core"
```

### Why core, not server

Wire types are a deployment-level contract shared by *both*
the worker (producer) and the web app (consumer). Locating
them in the consumer's package would create a circular
dependency (the worker needs the same types); locating them
in the worker's package would expose Cloudflare-runtime
internals to the web client. `@booking/core` is the layer
both sides already depend on for the algebra, so making it
the type origin closes the loop.

### Package boundary

`packages/core/package.json` publishes per-domain
sub-exports (`@booking/core/projection`,
`@booking/core/wire`, …). Sub-paths exist as a forward-
compatibility seam: if the projection layer ever ships
its own package, the import sites already use the
sub-path, so the move is a JSON change rather than a
codebase-wide grep + replace.

## Consequences

- `apps/web/src/lib/api.ts` shrinks by ~120 lines (the
  hand-written `StaffShopState` and friends are gone).
  Any type drift between the server's payload and the
  client's narrowing is now a compile error rather than
  a runtime "field is `undefined`" surprise.
- `dependency-cruiser` enforces direction: `apps/web` →
  `@booking/core` is allowed; the inverse (or
  `@booking/core` → Cloudflare runtime APIs) is rejected
  by the existing layer rules.
- The web app's `ShopStateDelta` / `StaffShopStateDelta`
  applications go through the canonical
  `applyShopStateDelta` / `applyStaffShopStateDelta`
  helpers from core — no parallel implementation drift.

## Status

- 2026-05-11 — Web types migrated to `@booking/core` in
  commit `e0ba56e`.
- 2026-05-12 — ADR file backfilled in the obs sprint
  cleanup (the commit's ADR-0086 citation was a dangling
  reference until now).
