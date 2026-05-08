# 0013. Booking state machine: total transition function on a tagged union

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: domain, correctness

## Context

`Booking` has a small but non-trivial state machine (Held → Confirmed → Cancelled / Completed / NoShow, plus reschedule). The naïve approach is to give `Booking` a single shape with a `state: string` field and gate behaviour in conditionals. That makes "what does `Booking.completedAt` mean while `state === 'Held'`?" a forever question.

## Decision

`Booking` is a **discriminated union**, with each variant carrying only the fields that are meaningful in that state:

```ts
type Booking =
  | { state: "Held"; expiresAt: Temporal.Instant; … }
  | { state: "Confirmed"; confirmedAt: Temporal.Instant; … }
  | { state: "Cancelled"; cancelledAt: Temporal.Instant; reason: string; cancelledBy: "customer" | "staff"; … }
  | { state: "Completed"; completedAt: Temporal.Instant; … }
  | { state: "NoShow"; markedAt: Temporal.Instant; markedBy: "staff"; … }
```

Transitions are a single **total** function:

```ts
const apply: (booking: Booking, command: BookingCommand) => Result<Booking, DomainError>
```

Properties:

- `BookingCommand` is itself a discriminated union — exhaustiveness is checked by the compiler.
- The function never throws; invalid `(state, command)` pairs return `Err(DomainError)` (see ADR-0010).
- For each successful transition, exactly one `BookingEvent` is appended, paired with the new state in the function's return.
- A `_exhaustive: never` assignment guards the default branch; it is unreachable, no `throw` required.

## Consequences

- Refactoring is mechanical: adding a new state forces every `switch` to update or compile-error.
- "Make illegal states unrepresentable": `Booking.completedAt` can only be referenced inside the `Completed` branch.
- Stateful property tests (fast-check `commands`) drive command sequences against the apply function and check global invariants (e.g., "events length ≤ commands length", "no transition produces fields it didn't claim").

## Consequences (negative)

- More boilerplate per state than the flat-shape approach. Acceptable price.
- TypeScript narrow-then-spread sometimes needs explicit type annotation; we accept that.

## Alternatives considered

- **Flat shape with optional fields**: invalid combinations are spelled with `undefined`; correctness lives in conditionals.
- **xstate**: a full FSM library is heavier than the few states we have.
- **Effect.match on a tag**: equivalent to discriminated unions but couples the state machine to Effect's runtime where it doesn't need to be.

## References

- SYSTEM.md §3.6, §4.5.3.
- Effective TypeScript, item 28 ("Make illegal states unrepresentable").
