# ADR-0092: `/dev/inspect` 4-pane observability surface

- Status: Accepted
- Date: 2026-05-12
- Stage: F / S23
- Refines: ADR-0088 (client obs ring), ADR-0091 (dev log
  stream DO), ADR-0087 (web shell / Modal ADT)

## Decision

Add a single SvelteKit route `/dev/inspect` that renders a
live cross-section of every signal the obs sprint added:

```text
┌────────────── Ring ──────────────┬─────────── Stream ─────────────┐
│ client obsBus snapshot           │ server structured-log relay    │
│ FetchStart/End/Error, WsFrame*,  │ HttpRequest, HttpEnvelope,     │
│ StoreMutation, UncaughtError,    │ ClientReport, AlarmSweep, …    │
│ Lifecycle                        │ via /api/v1/__/dev/log-stream  │
├────────────── State ─────────────┼─────────── Detail ─────────────┤
│ shopStateStore.value (live       │ full JSON of whichever row is  │
│ projection, snapshot/delta       │ selected in any pane           │
│ merged)                          │ ($derived.by on a tagged       │
│                                  │ selection ADT)                 │
└──────────────────────────────────┴────────────────────────────────┘
```

### Gating — defence in depth

Two independent gates, both fail-closed:

1. **Build-time** — `+page.ts` calls `error(404)` when
   `$app/environment.dev` is false. Production builds tree-
   shake the route handler entirely; the chunk is excluded
   from the prod bundle.

2. **Server-side** — the upstream
   `/api/v1/__/dev/log-stream` WS upgrade rejects with 404
   when `IS_DEV !== "1"` (S22 cont. / ADR-0091). Even if a
   client bypasses the build-time gate, the WS subscription
   refuses.

The two gates are intentionally redundant. Either one alone
is sufficient; together they survive a misconfigured deploy
that flips one but not the other.

### Selection cursor as a tagged union

```ts
// devInspectorState.svelte.ts
export type DevInspectorSelection =
  | { readonly tag: "ring";   readonly index: number }
  | { readonly tag: "stream"; readonly index: number }
  | { readonly tag: "state" }

export const devInspectorState = $state<{ selection: DevInspectorSelection | null }>({
  selection: null,
})
```

The Detail pane reads the cursor through a single
`$derived.by` switch over the discriminant — the same ADT
pattern the customer + staff Modal hosts already use (S19
/ ADR-0087). Adding a new pane is one variant + one branch
in the derivation.

### Why no automatic reconnect

Dev surfaces stay silent on transient failures so the
developer notices when their dev tunnel is wrong. The
`status` pill (`connecting | open | closed`) flips to
`closed` on disconnect; reopening is a page refresh. A
production observability tool would auto-reconnect; this
is not that surface.

## Consequences

- The four signal sources (`obsBus.snapshot`, the WS
  relay, `shopStateStore.value`, the selection cursor) are
  composed without copy — each pane reads its own source
  directly, and the Detail pane projects through the
  selection ADT.
- Dependency-cruiser exemption updated to cover
  `lib/dev/*.svelte.ts` (the existing carve-out for
  Modal-host vocabulary modules — depcruise doesn't parse
  `.svelte`, so their consumers are invisible to the
  orphan check).
- `+error.svelte` (S24) lives next to the dev surface in
  the routes tree; the two have no runtime overlap.

## Status

- 2026-05-12 — Page + state + WS subscriber land in
  commit `7f864ab`.
