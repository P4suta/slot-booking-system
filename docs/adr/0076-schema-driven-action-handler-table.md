# ADR-0076: Schema-driven QueueAction handler table

- Status: accepted
- Date: 2026-05-22
- Refines: ADR-0051 (event-sourced queue), ADR-0065 (operator-grade actions)
- Tags: architecture · durable-object · effect

## Context

`QueueShop.dispatch` is the single entry point through which the
worker hands a state-changing intent to the Durable Object actor.
With ADR-0050 (queue pivot) the union of intents grew from the
five customer-facing verbs (Issue / CallNext / MarkServed /
MarkNoShow / CancelTicket) to fourteen, after ADR-0062 (lanes),
ADR-0065 (operator-grade CallSpecific / CallBatch / Reorder),
ADR-0066 (reservation reschedule), ADR-0068 (check-in), ADR-0071
/ ADR-0072 (Overdue / Nudge), and ADR-0075 (appointment lapse).

The previous implementation routed each variant through a 14-arm
`switch (action.type) { case "...": eff = ...; break }` block
that initialised a top-level `let eff: Effect.Effect<...>` per
case. Two regressions were waiting in that shape:

1. **Drop-through silence.** A missing `break` would happily
   reassign `eff`, with no compile-time signal that another arm
   was supposed to run first.
2. **Adding a variant did not fail.** TypeScript narrows `action`
   inside each case but does not error when one of the union's
   discriminator values has no matching case — the value falls
   through to a `eff` that the type system thinks remains
   `Effect<DispatchOk, ...>` (it is in fact never initialised at
   that path) and `Effect.runPromise(undefined as any)` panics at
   runtime instead of at the type checker.

The router in `apps/default/src/server/http/router.ts` also
edits in lock-step with this switch: every new action requires a
boundary schema in `boundarySchemas.ts`, a route handler in
`router.ts`, and a new `case` arm in the switch. The three
edits have no shared compile-time link.

## Decision

Drive `QueueShop.dispatch` through `Effect.Match.discriminatorsExhaustive("type")`
over the `QueueAction` union. The handler table is a single
object literal mapping each discriminator value to a function
that returns the `Effect` for that action.

`Match.discriminatorsExhaustive` enforces (at the type level)
that every variant in `Types.Tags<"type", QueueAction>` has a
matching key. Adding a new `QueueAction` variant without
registering a handler is a compile error at the matcher.

`QueueAction` itself lifts out of `QueueShop.ts` into
`apps/default/src/server/durableObjects/actions.ts`, the
single module the worker (`router.ts`) and the DO both import
from. The two sides can no longer drift on the discriminated
union shape.

## Consequences

**Easier**:

- Adding a `QueueAction` variant is one schema change in
  `boundarySchemas.ts` + one entry in the `discriminatorsExhaustive`
  table. The TypeScript checker enumerates every missing arm.
- The dispatch body becomes a flat declarative table; reviewers
  diff one function map against the `actions.ts` union.
- The `Effect` return-type union from each arm is unified
  automatically by `discriminatorsExhaustive`, so the local
  `let eff` declaration disappears.

**Harder**:

- Per-action setup that does not fit a one-liner (e.g.
  `IssueTicket` decoding `appointmentAt` from ISO string,
  `RescheduleTicket` decoding `newAppointmentAt`) lives inside
  the arrow body. Multi-line arrow functions are fine but the
  pattern is less linear than a `case` block.
- Reading the dispatch top-to-bottom requires familiarity with
  `Match.discriminatorsExhaustive` (the project already commits
  to Effect as the application substrate, so this is a
  one-paper-read cost, not a long-term burden).

## Alternatives considered

- **Object map + `satisfies`.** A plain
  `const handlers: { [T in QueueAction["type"]]: (a, ctx) => Effect<...> } = { ... }`
  satisfies the same exhaustiveness check via `satisfies`.
  Closer to ADR-0031's "transition table = spec" framing.
  Rejected because the project already routes use-case
  composition through Effect, and `Match.discriminatorsExhaustive`
  composes naturally with the surrounding `Effect.matchCauseEffect`
  pipeline. A bare object map needs an additional `eff =
  handlers[action.type](action)` plus a manual `Effect`-typing
  step.
- **`@effect/rpc`.** Heavier surface, ties the DO RPC envelope
  to the rpc package's wire format. Out of scope for the current
  queue domain; ADR-0044 already records the structuredClone
  boundary trade-off.

## References

- `apps/default/src/server/durableObjects/actions.ts`
- `apps/default/src/server/durableObjects/QueueShop.ts#dispatch`
- Plan: `~/.claude/plans/purrfect-strolling-crescent.md`
- Effect Schema docs: [`Match.discriminatorsExhaustive`](https://effect.website/docs/code-style/pattern-matching/#match-by-discriminator)
