# ADR-0063: Serving intermediate state + NoShow alarm cutoff

- Status: Accepted
- Date: 2026-05-09
- Refines: ADR-0050 (queue pivot), ADR-0052 (type-state Ticket), ADR-0059 (event-log SoT)

## Decision

Add a `Serving` state to the `Ticket` discriminated union,
positioned between `Called` and `Served`:

```
Waiting → Called → (Serving) → Served | NoShow
```

`Serving` is reached via a new transition `applyStartServing`
(`Called → Serving`). `applyMarkServed` accepts both `Called`
and `Serving` as source. `applyMarkNoShow` only accepts
`Called` — once the customer is being served the alarm-driven
NoShow sweep no longer applies.

## Context

The pre-Tier-B state machine collapsed two operationally distinct
periods into a single `Called` state:

1. **The "I called the customer, they have not yet arrived at the
   counter"** window. This is short (seconds to a few minutes)
   and is the legitimate target of the NoShow alarm.
2. **The "the customer is at the counter, I'm serving them
   now"** window. This is longer (minutes to tens of minutes)
   and **must not** be NoShow-swept — the customer is right there.

When both periods share a state, the NoShow alarm has to either
fire too early (and false-positively reset Serving customers) or
too late (and miss real no-shows). The current implementation
sets the alarm conservatively long, leaving a real-world tail of
ghost tickets that operators have to hand-cancel.

## Trade-offs

| | Single `Called` | **`Called` + `Serving`** | Multiple "post-call" sub-states |
|--|--|--|--|
| Distinguish "waiting at counter" vs "being served" | no | yes | yes |
| NoShow alarm precision | conservative tail | tight (`Called` only) | tight |
| Type-state width | 5 states | 6 states | 5 + N |
| Operator action surface | 3 (Served / NoShow / Recall) | **4** (Start Serving / Served / NoShow / Recall) | unbounded |
| Audit trail granularity | issue / call / outcome | issue / call / **start-serving** / outcome | issue / call / step₁ / step₂ / … / outcome |

The two-step (Called → Serving → Served) split is the minimum
extension that makes the NoShow alarm well-defined while keeping
the operator action surface small. Further splits ("payment
processing", "post-care") are domain-specific and out of scope
for the agnostic core.

## Implementation

- `Ticket` discriminated union gains:
  ```ts
  ServingSchema = Schema.Struct({
    ...TicketCommonFields,
    state: Schema.Literal("Serving"),
    calledAt: Instant, calledBy: Actor,
    servingStartedAt: Instant, servingStartedBy: Actor,
  })
  ```
- `transitions.ts` adds `applyStartServing(t: Called) → Serving`
  and broadens `applyMarkServed` to `Called | Serving → Served`.
- `TicketEvent.ts` adds `ServingStarted { ticketId,
  servingStartedAt, servingStartedBy }`.
- `QueueShop.ts` adds the `StartServing { ticketId; actor }`
  action. The NoShow alarm scan filters `state === "Called"`
  only; tickets that have transitioned to `Serving` are
  invisible to the alarm.
- `guardActive()` (ADR-0052's terminal-state guard) classifies
  `Serving` as active alongside `Waiting` and `Called`.

## Consequences

- The staff dashboard gains a new column ("Serving") between
  Called and Done. The keyboard shortcut `S` triggers
  StartServing on the focused ticket; `C` triggers MarkServed
  (which is now meaningful from both `Called` and `Serving`).
- The ADR-0009 PII retention TTLs apply to terminal states
  (`Served / NoShow / Cancelled`) unchanged — `Serving` is
  active and lives until the operator marks it Served / NoShow.
- The customer-facing screen treats `Serving` the same as
  `Called` from the customer's perspective ("you have been
  called, please go to the counter") — the distinction matters
  only on the operator side.
- Existing tickets in `Called` state at the migration boundary
  remain in `Called` (no automatic upgrade to `Serving`); the
  alarm wakes correctly because its predicate is unchanged
  (`state === "Called"` was always the precondition).
