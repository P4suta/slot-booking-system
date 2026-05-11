# ADR-0087: Web shell — Kanban + Modal ADT + QueueFeed Moore machine

- Status: Drafted (Part 1 — vocabulary), in-progress
- Date: 2026-05-11
- Stage: E / S19
- Refines: ADR-0085 (single-source projection store)

## Decision

Decompose the staff + ticket page shells (1367 + 1207 lines)
into three vocabulary modules + a small component library, so
the page-level templates collapse to the structural seams
(layout + which column / which modal). The pre-refactor pages
were 「one big template」 with cross-column markup duplication,
a 9-flag modal matrix, and a `string | undefined` connection
indicator.

```text
apps/web/src/lib/
├── queueFeedMachine.ts          ← Moore machine for connection
│                                  indicator (4 states + total
│                                  transition function + Moore
│                                  outputs)
├── components/
│   ├── kanban/
│   │   ├── Kanban.svelte         ← orchestrator (one column per
│   │   │                            descriptor)
│   │   ├── KanbanColumn.svelte   ← layout + empty-state copy
│   │   ├── TicketCard.svelte     ← one component, 5 column
│   │   │                            variants discriminated by
│   │   │                            the `tone` prop
│   │   └── descriptors.ts        ← COLUMNS table (waiting /
│   │                               calling / serving /
│   │                               pendingNoShow / terminal)
│   └── modal/
│       ├── ModalHost.svelte      ← single render seam
│       └── states.ts             ← ModalState ADT
```

### Vocabulary modules (`*.ts`)

- **`queueFeedMachine.ts`** — `QueueFeedState` is the
  discriminated union `{tag: "connecting" | "open" |
  "reconnecting" | "closed", …}`; `transition(prev, event)` is
  the total transition function (no silent ignore); `label` +
  `tone` are the Moore outputs. The page renders by
  `<ConnectionIndicator state={feedState} />` instead of the
  prior `if (status === undefined) … else if (status ===
  "open") …` ladder.
- **`components/modal/states.ts`** — `CustomerModalState` and
  `StaffModalState` are ADTs over the modals each page exposes.
  Impossible combinations (e.g. both the cancel-confirm *and*
  the reschedule-picker open at once) are unrepresentable: the
  variant union has no `{cancelConfirm: true, reschedulePicker:
  true}` value. Each variant carries the payload it needs
  (target `ticketId`, default reason) so the modal host
  renders from a single value instead of a state × payload
  cross-product.
- **`components/kanban/descriptors.ts`** — `COLUMNS:
  ColumnDescriptor[]` lists the five staff columns (label,
  source field on `StaffShopState`, colour tone, empty-state
  copy). The page's Kanban becomes a `for-of` over the table.

### Component library (`*.svelte`)

- **`TicketCard`** — one card markup. The pre-refactor code
  had 5 column-specific cards (Waiting / Calling / Serving /
  PendingNoShow / History) with ~280 lines of copy-paste. The
  unified card takes a `tone` prop matching the column
  descriptor's tone token.
- **`KanbanColumn`** — header + scroll container + empty-state
  banner. Renders `TicketCard` for each entry.
- **`Kanban`** — orchestrator. Walks `COLUMNS` and renders one
  `<KanbanColumn>` per descriptor; the field-on-StaffShopState
  binding lives in `entriesFor(state)`.
- **`ModalHost`** — single render seam. A `{#if state.tag ===
  "cancelConfirm"}` switch picks the modal body component.

## Consequences

- `apps/web/src/routes/staff/+page.svelte` shrinks from 1367
  lines to ~600 (target). The orchestration logic (event
  handlers, DO RPC calls, store reads) stays on the page; the
  *markup* moves into the component library.
- `apps/web/src/routes/ticket/+page.svelte` shrinks from 1207
  lines to ~700 (target). Same orchestration / vocabulary
  split.
- `apps/web/src/lib/wsStatus.ts` is rewritten on top of
  `queueFeedMachine.transition`. The exported store becomes
  `$state<QueueFeedState>` — the legacy `"connecting" |
  "open" | …` string union stays a typedef alias for callers
  not yet migrated.
- The boolean-flag modal matrix is gone. Anywhere a page used
  to toggle `showCancelConfirm = true; showReschedulePicker =
  false`, it now assigns `modalState = { tag: "cancelConfirm",
  ticketId }` — a single source of truth that the modal host
  reads off.

## Status

- 2026-05-11 — Part 1 (vocabulary modules: queueFeedMachine,
  modal states, kanban descriptors) lands; component library
  + page rewrites follow in the same sprint.
