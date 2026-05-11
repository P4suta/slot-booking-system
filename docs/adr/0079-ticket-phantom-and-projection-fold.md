# ADR-0079: `TicketT<S>` phantom + projection as free-monoid fold

- Status: Accepted
- Date: 2026-05-11
- Stage: A / S3 + S4
- Extends: ADR-0052 (type-state ticket)
- Refines: ADR-0059 (event log as source of truth)

## Decision

### Part 1 (S3) — central type-guard registry

Promote the six per-state type guards (`isWaiting`, `isCalled`,
`isPendingNoShow`, `isServed`, `isNoShowState`, `isCancelled`) plus the
two partition predicates (`isActive`, `isTerminal`) into a single
exported registry on `packages/core/src/domain/queue/Ticket.ts`. Each
guard narrows `Ticket` to its `TicketT<S>` variant via the existing
phantom alias, so call sites that branch on a guard inherit the
state-dependent fields (`calledAt` on `TicketT<"Called">`, `markedAt`
on `TicketT<"PendingNoShow">`, …) at the type level without a second
narrow.

`ACTIVE_TICKET_STATES` / `ActiveTicketState` mirror the existing
`TERMINAL_TICKET_STATES` / `TerminalTicketState` so the partition
identity `isActive ↔ ¬isTerminal` is structural and pinned by test.

### Part 2 (S4) — projection as free-monoid fold

Drop the local guard declarations in
`packages/core/src/domain/queue/projection.ts` (lines 202-204:
`isWaiting`, `isCalled`, `isPendingNoShow`) and import the central
versions. The projection's `applyEvent` becomes a thin dispatch into
`transitions.apply*` — a single transition table read from two
perspectives:

- **forward** (`transitions.ts`) — Command → state shift returning
  `{ticket, event}` for the event log.
- **fold** (`projection.ts`) — Event → state shift for replay
  (`replay(xs ++ ys) = applyMany(replay(xs), ys)`, monoid
  homomorphism law already pinned in `homomorphism.test.ts`).

After S4 the only place that decides "what does this event do to a
ticket" is `transitions.ts`; projection is a structural mirror.

## Context

Three drift traps justified the split-and-collapse:

1. **`projection.ts:202-204`** redeclared the per-state guards
   locally — file-private symbols that downstream consumers couldn't
   reuse. The use-case files
   (`application/usecases/queue/CallNext.ts`, `Recall.ts`,
   `MarkServed.ts`, `CancelTicket.ts`, `RescheduleTicket.ts`)
   redeclared their own state checks as `if (loaded.state.state !==
   "Called") return …`. Five duplicates of the same predicate.
2. **`projection.ts` switch / `transitions.ts` apply* functions**
   each enumerated every event variant. Adding a new event (e.g.
   `Recall` after PendingNoShow was widened in ADR-0074) required
   touching both files; the typed `applyRecall` returned a
   `Waiting`-typed result but the untyped `applyEvent("Recalled", …)`
   case rebuilt the same fields by hand.
3. **`isTerminal` was the only central partition predicate.** Its
   complement `isActive` was reconstructed inline at every consumer
   (`!isTerminal(t)` or per-state OR chains), masking the partition
   identity behind ad-hoc boolean algebra.

## Consequences

- **Pro**: A use-case body that runs `if (!isCalled(loaded))` gets
  `loaded` narrowed to `TicketT<"Called">` — `calledAt`/`calledBy`
  become required fields at compile time. S5 (`runCommand` Kleisli
  combinator) builds on this.
- **Pro**: `applyEvent` shrinks; new events land in one file
  (`transitions.ts`) and projection delegates.
- **Pro**: The partition `isActive ↔ ¬isTerminal` is enforced by
  property test, so future state-set changes can't violate it
  silently.
- **Con**: One more name to remember in the predicate space
  (`isActive`). The alphabetical layout in `Ticket.ts` near
  `isTerminal` mitigates this.

## Follow-ups

- ADR-0080 (S5 + S6): `runCommand` Kleisli combinator + refinement
  intersection for `applyReschedule`'s `appointmentAt` precondition.
- ADR-0081 (S9): `ORSet<TicketId>` membership for `callableNow` —
  uses `isWaiting` ∧ `isCallableNow` at delta time.
