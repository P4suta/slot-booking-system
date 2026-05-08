# ADR-0052: Type-state Ticket aggregate

- Status: Accepted
- Date: 2026-05-08
- Supersedes: ADR-0013 (total state transitions, slot-graph era)

## Decision

`Ticket` is a discriminated union over five variants — `Waiting`,
`Called`, `Served`, `NoShow`, `Cancelled` — keyed by `state`. The
type-state phantom

```
type TicketT<S extends TicketState> = Extract<Ticket, { state: S }>
```

lets call sites pin the variant at compile time. The right-side
smart constructors in `domain/queue/transitions.ts` accept only the
source state whose outgoing edge they own:

```
applyCallNext  : Waiting → Result<{ Called, CalledEvent }>
applyMarkServed: Called  → Result<{ Served, ServedEvent }>
applyMarkNoShow: Called  → Result<{ NoShow, NoShowedEvent }>
applyCancel    : Waiting | Called → Result<{ Cancelled, CancelledEvent }>
```

Issuing a wrong-state command (e.g. `MarkServed` against a `Waiting`
ticket) is a **type error at the call site**, not a runtime
`InvalidStateTransition` left. The use case body's `if state !== "Called"`
guard is the single runtime check that runs after `loadOrTicketNotFound`.

## Consequences

- The transition algebra is total: every reachable `(state, command)`
  edge is one named function. Adding a new state or command is a
  three-line edit (variant Schema + apply function + use case
  caller).
- The state machine's lattice diagram is:

```
                     ┌──── Cancel ────┐
                     ▼                │
   Waiting ──Call──→ Called ──Served──→ Served (terminal)
       │                │  ──NoShow──→ NoShow (terminal)
       └─Cancel─────────┴──Cancel────→ Cancelled (terminal)
```
