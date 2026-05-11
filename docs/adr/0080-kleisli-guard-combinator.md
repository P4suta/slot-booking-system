# ADR-0080: `runCommand` Kleisli combinator + refinement intersection

- Status: Accepted
- Date: 2026-05-11
- Stage: A / S5 + S6
- Depends-on: ADR-0079 (`TicketT<S>` phantom)

## Decision

### Part 1 (S5) — `runCommand`

Add a `runCommand<S extends TicketState>(spec)` combinator in
`packages/core/src/application/usecases/_withUseCaseEnv.ts` that
captures the load + guard + narrow + persist tail shared by every
tail-identical queue command:

```ts
type CommandSpec<S> = {
  ticketId: TicketId
  command: TicketCommand          // both error tag and audit log tag
  from: S | readonly [S, ...S[]]   // accepted source state(s)
  apply: (src: TicketT<S>, at, eventId) => ApplyResult
  code: string
  data: Readonly<Record<string, unknown>>
}
```

The four single-state and two-state commands collapse onto this
combinator:

| Use case            | from                          | applied helper            |
|--------------------|-------------------------------|---------------------------|
| `MarkServed`        | `"Called"`                   | `applyMarkServed`         |
| `MarkPendingNoShow` | `"Called"`                   | `applyMarkPendingNoShow`  |
| `MarkNoShow`        | `["Called", "PendingNoShow"]` | `applyMarkNoShow`         |
| `Recall`            | `["Called", "PendingNoShow"]` | `applyRecall`             |

Each use case shrinks from 14-18 lines to 9-12 — the load,
`guardActive`, `invalidTransition` narrow, and `applyAndPersist`
plumbing live in `runCommand`. The Kleisli arrow is over `Effect`'s
`>>=`: it lifts the pure pre-condition (`source ∈ from`) into the
effectful pipeline, leaving the persistence epilogue unchanged.

`CallSpecific`, `CancelTicket`, `CheckIn`, `CallNext`, `IssueTicket`,
`RescheduleTicket`, `CallBatch` stay out of the combinator —
`CallSpecific` needs `lane` in its audit log; `CancelTicket` runs
handle-based authentication; `CheckIn` has appointment-window
preconditions; `CallNext` re-derives the head from a projection;
`IssueTicket` uses the sibling `issueAndPersist`; `RescheduleTicket`
gets a separate refinement-intersection treatment in part 2.

### Part 2 (S6) — refinement intersection (separate commit)

`applyReschedule` currently raises `throw new Error(...)` when its
defensive `appointmentAt === null` guard fires (transitions.ts:353).
The "no throw in transitions" rule (user philosophy, ADR-0017
error handling) wants this elevated to the type:

```ts
type Reschedulable<T extends Ticket> = T & { readonly appointmentAt: NonNullable<T["appointmentAt"]> }
```

`RescheduleTicket` does the boundary refinement once (one
`AppointmentRequiredForReservationLaneError` `Effect.fail` at the
edge); the apply* helper receives `Reschedulable<...>` and the
throw becomes structurally unreachable. Documented for S6.

## Context

Five use case bodies repeated the same five-step procedure:

```ts
const loaded = yield* loadOrTicketNotFound(ticketId)
const terminal = guardActive(loaded.state)
if (terminal !== null) return yield* Effect.fail(terminal)
if (loaded.state.state !== "X") {
  return yield* Effect.fail(invalidTransition(loaded.state.state, "X"))
}
const source = loaded.state
return yield* applyAndPersist({ loaded, apply: ..., log: ... })
```

The narrowing on the runtime state-tag couldn't be expressed without
either casting (`as TicketT<"X">`) or a separate type guard
invocation; every use case copy-pasted both the narrow and the
`invalidTransition` literal. A new transition (e.g. adding
`MarkPendingNoShow` in ADR-0074) required two changes per call site
— one for the state guard and one for the error tag — and every
mismatch ended in a runtime-only `InvalidStateTransitionError`.

## Consequences

- **Pro**: Four use cases shrink to declarative specs. Adding a
  new tail-identical command is a 12-line file.
- **Pro**: The `TicketCommand` literal union now flows through the
  combinator's `command` field, so misspelling a tag is a compile
  error rather than a runtime audit-log drift.
- **Pro**: Future widening of accepted source states (e.g. allowing
  `Recall` from yet another active state) lives in `from: [...]`,
  not in three places per use case.
- **Con**: The combinator has a single `as TicketT<S>` cast (line
  181). TypeScript can't relate `Array.includes` to type narrowing;
  the cast is necessary because the runtime check is what proves
  the predicate. Type-coverage stays above the 99.5% threshold.
- **Con**: `CallSpecific` / `CancelTicket` / `CheckIn` /
  `RescheduleTicket` stay outside — their extra preconditions
  don't compress into a single uniform spec without inflating the
  combinator's surface. Acceptable: those four bodies were already
  small.

## Follow-ups

- ADR-0081 (S7-S9): CRDT primitives + Wire v6 + ShopState
  semilattice.
