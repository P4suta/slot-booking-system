# ADR-0085: Single-source projection store — `shopStateStore`

- Status: Accepted
- Date: 2026-05-11
- Stage: E / S17
- Refines: ADR-0061 (DO hibernating WebSocket projection feed),
  ADR-0083 (per-capability WS frame variant), ADR-0075 (delta
  broadcast)

## Decision

Make the WebSocket projection feed the *only* source of truth
for the live `ShopState` on the client. The new
`apps/web/src/lib/stores/shopState.svelte.ts` Svelte 5 store
holds `ShopState | StaffShopState | null` in a `$state` rune;
`connectQueueFeed` writes every snapshot + applied delta into
it. Every `.svelte` consumer reads via the same store, so a
route never has to mirror the wire payload through its own
local variables.

The old REST-refetch loop on `/staff` is gone. Pre-S12 the
WebSocket only carried the anonymous (PII-free) frame, so the
staff page had to fall back to `staffShopState(token)` after
every WS push to fetch the PII payload. S12 lifted that
constraint by adding the per-capability frame variant
(`StaffShopState`); the staff WS now delivers PII directly, and
the REST endpoint is no longer needed for live updates.

### Why a single store

1. **CQRS alignment.** The WS is the read side; the HTTP POST
   endpoints are the write side. With S17 in place the read side
   has exactly one origin, and the client cannot fall out of sync
   between two parallel state sources (the prior REST mirror
   could lag the WS by the round-trip time of one fetch).
2. **No type drift between REST and WS payloads.** The hand-
   written `StaffShopState` in `apps/web/src/lib/api.ts` is gone;
   the store consumes the canonical `@booking/core` shape, so a
   server-side field rename surfaces as a `tsc` error.
3. **Cheaper staff page.** Every WS broadcast no longer
   triggers an HTTP fetch + JSON parse round trip. On a busy
   shop hour with 10 dispatches/min that's 10 saved
   `RL_VERIFY` budget hits + 10 less round trips.

### Wire-level requirement

For the WS to be a complete read source, the staff frame must
carry every field the staff UI consumes. ADR-0083 part 2 added
PII + the four standard projection arrays; this ADR adds the
`terminal` array (recent Served/Cancelled/NoShow, sliced
`seq desc[0..8]`) to `StaffShopState`. Both `computeStaff
ShopStateDelta` and `applyStaffShopStateDelta` route through
this new field via the existing `staffArrayDelta` helper, so
delta semantics stay symmetric across the five arrays
(`calling`, `serving`, `pendingNoShow`, `waitingPreview`,
`terminal`).

### Why a store, not a callback

Pre-S17 the WS handler accepted `onProjection` callbacks; each
page wired its own state setter and (in the staff case) an
extra REST refetch closure. The callback API is kept for
incremental migration (anyone who needs a side-effect on every
update can still register one), but new code reads the store
directly. Svelte 5's `$state` rune is reactive across module
boundaries, so a single `$state` value is a clean replacement
for "N callbacks each updating M local variables".

## Consequences

- `apps/web/src/lib/api.ts`: removes the hand-written
  `StaffShopState` declaration + the `staffShopState(token)`
  REST function. `connectQueueFeed` gains capability-aware
  delta merging (anonymous → `applyShopStateDelta`, staff →
  `applyStaffShopStateDelta`) and writes the result into the
  store before invoking the legacy callback.
- `apps/web/src/routes/staff/+page.svelte` /
  `apps/web/src/routes/ticket/+page.svelte`: the local page
  state derives from the store via `$derived(shopStateStore.value)`;
  the `refresh()` REST loop on `/staff` is deleted.
- Server: `Projector.buildStaffShopState` now produces the
  `terminal` array. The REST `/api/v1/queue` handler still
  exists (admin tooling + the OpenAPI surface use it) but the
  staff UI no longer hits it during live operation.

## Status

- 2026-05-11 — Store + capability-aware merge land. Staff page
  REST refetch on every WS push is removed; the `staffShopState`
  helper is deleted entirely. Anonymous + staff WS frames merge
  into the same store.
