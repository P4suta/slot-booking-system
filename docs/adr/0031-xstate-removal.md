# 0031. Remove the xstate runtime; the transition table is the spec

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: state-machine, dependency-pruning

## Context

Phase 0.5 wrapped a value-level `TRANSITIONS` adjacency table in
`xstate.createMachine(...)`. The xstate runtime was used by exactly
one test (`bookingMachine.states.keys`); every production consumer
read from `TRANSITIONS` directly. The xstate dependency added ~30 KB
to the bundle, plus an external surface that diverged from the
table (xstate transitions had to be hand-mirrored).

## Decision

Drop the xstate dependency. Keep the value-level `TRANSITIONS`
table as the runtime spec; cross-validate `apply` against it in
`machine.test.ts` (every (state, command) pair). Phase 0.7-α3
promoted the table to the type level (`TransitionTable`,
`AllowedCommandKinds<S>`, `NextState<S, K>`) so the same lattice
is queryable at compile time.

## Consequences

- **Pros**: ~30 KB bundle savings; the table *is* the
  specification, no hand-mirroring; the cross-validation test is the
  contract.
- **Cons**: lose xstate's introspection / visualization surface —
  but the table is a pure JS literal that any DOT/Mermaid emitter
  can render without runtime dependencies.

## References

- ADR-0013 (total state transitions)
- `packages/core/src/domain/booking/machine.ts`
- `packages/core/src/domain/booking/transitions.ts`
- `packages/core/test/booking/machine.test.ts`
