# 0020. Application ports are expressed as Effect.Context.Tag classes

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: ports, effect, layering

## Context

ADR-0018 defines a Functional Core / Imperative Shell split. The
shell needs ports — clock, id generator, repository, event store,
logger — that the core requires but does not implement. Phase 1 will
need to swap those ports between production (Cloudflare bindings) and
tests (deterministic in-memory). The mechanism must be:

- Type-driven: a use case that needs `Clock` should fail to compile
  if no `Clock` layer is provided.
- Composable: multiple ports compose into one `Layer` per environment.
- Test-friendly: a deterministic `IdGenerator` can be plugged in
  without changing the use-case code.

Effect's `Context.Tag` plus `Layer` covers all three.

## Decision

Every application port is declared as a `Context.Tag` **class**
under `packages/core/src/application/ports/`:

```ts
export class Clock extends Context.Tag("@booking/core/Clock")<
  Clock,
  { readonly nowInstant: Effect.Effect<Temporal.Instant> }
>() {}
```

Five ports are defined in Phase 0.5:

| Port | Role |
|---|---|
| `Clock` | wall-clock reads (`Temporal.Now.instant()`) |
| `IdGenerator` | every `new*Id` and `newBookingCode` |
| `BookingRepository` | aggregate-scoped persistence (D1 binding in production) |
| `EventStore` | append-only event log (DO SQLite in production) |
| `Logger` | structured logging (`LogPayload` in / out) |

For each port at least two `Layer`s exist:

| Layer | Purpose |
|---|---|
| `XxxLive` | production wiring (Temporal, typeid-js, Cloudflare bindings) |
| `makeXxxFake(seed?)` / `XxxFakeLive` | deterministic fake for tests |

The `Layer`s live in `packages/core/src/infrastructure/<port-family>/`
when they are runtime-agnostic (Clock, IdGenerator), or in
`apps/*/src/server/adapters/` when they require Cloudflare bindings
(BookingRepository, EventStore, Logger).

`new*Id` exports on `domain/types/EntityId.ts` are kept for
backwards-compatibility with existing test fixtures; they will be
removed in a follow-up ADR once those fixtures migrate to the
`IdGenerator` Layer.

## Consequences

- **Pros**: use cases declare their dependency footprint in their
  return type (`Effect.Effect<A, E, Clock | IdGenerator | …>`).
  Wiring is by composition (`Layer.merge`), test wiring is by
  substitution (`Effect.provide(SystemClockLive)`).
- **Cons**: setup boilerplate per port. Not all ports needed in
  Phase 1 are wired in Phase 0.5; that is intentional.

## Alternatives considered

- **Constructor injection** (classic OO DI): no static check that
  every dependency is satisfied; loses Effect's typed `R` parameter.
- **Module-level singletons with environment toggles**: untestable.
- **Reader monad by hand** (`(env) => …`): equivalent to Effect's
  Tag pattern but loses the rest of the Effect ecosystem.

## References

- ADR-0018 (FCIS).
- Step 2 (port draft), Step 14/15 (use cases that consume the ports).
- `packages/core/src/application/ports/`,
  `packages/core/src/infrastructure/`.
