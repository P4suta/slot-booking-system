# 0018. Functional Core / Imperative Shell — layer purity contract

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: architecture, effect, layering

## Context

Phase 0.5 introduces `Effect.Schema`, `Effect.Layer`, and `Context.Tag`-based
ports across the codebase. Without an explicit purity contract per layer
the team would gradually leak `Effect.Effect`, `Layer`, and runtime
side-effects into the domain. ADR-0008 established the *physical* split
(packages/core vs apps/\*) but not the *semantic* split between pure
data transformations and effectful coordination.

We adopt Gary Bernhardt's **Functional Core / Imperative Shell** (FCIS)
as the lens. Pure data lives in the core; effects live in the shell;
the shell calls the core, never the other way around.

## Decision

The codebase is partitioned into four layers with strict purity rules.
Each rule is enforced by `dependency-cruiser` (see
`.dependency-cruiser.cjs`) so violations fail CI.

| Layer | Path | Purity | May import |
|---|---|---|---|
| **domain** | `packages/core/src/domain/**` | **pure** — no `Effect`, `Layer`, `Context.Tag`. `Either`, `Option`, `Schema`, `Data` are OK. | itself only |
| **application** | `packages/core/src/application/**` | effectful via `Effect.Effect<A, E, R>`; `R` is a union of port `Tag`s. No `cloudflare:*` imports. | domain |
| **infrastructure** | `packages/core/src/infrastructure/**` | implements ports as `Layer`s. Runtime-specific dependencies allowed (`Temporal`, `typeid-js`, `ulidx`). No Cloudflare bindings here either — those go in `apps/*`. | domain, application |
| **presentation** | `apps/*/src/**` | Cloudflare Workers / SvelteKit / Drizzle adapters. Calls `Effect.runPromise` exactly once per request entry. | everything |

### Concrete rules

1. `domain/**` files **must not** `import { Effect, Layer, Context } from "effect"`.
   `Either`, `Option`, `Schema`, `Data`, `ParseResult` are explicitly allowed.
2. `application/usecases/**` files return `Effect.Effect<A, E, R>` where
   `R` is the union of every port `Tag` the use case requires.
3. `infrastructure/**` files implement ports via `Layer.succeed` /
   `Layer.effect`. Each port has at minimum two layers: a production
   `XxxLive` and a deterministic `MakeXxxFake` for tests.
4. `apps/<name>/src/server/**` is the only place that calls
   `Effect.runPromise`, and it does so once per HTTP request / form
   action.

### Trace through an example call

```
HTTP POST /book
  └─ apps/default/src/server/route.ts                  ← presentation
      └─ Effect.runPromise(holdSlot(req).pipe(
            Effect.provide(BookingRepositoryD1Live),
            Effect.provide(SystemClockLive),
            Effect.provide(UlidIdGeneratorLive),
            Effect.provide(LoggerWorkersLive),
         ))
      └─ holdSlot: Effect<Booking, DomainError, …>     ← application
          └─ apply(currentBooking, HoldSlot{…})         ← domain (pure)
              └─ Booking + BookingEvent (Either)
```

The application layer threads ports; the domain layer does not even
know they exist.

## Consequences

- **Pros**: domain layer stays trivially testable (no mocks, no
  layers, no async). Effect adoption can deepen without leaking into
  the place where business rules live. Future layers (e.g., Streams
  for outbox publishing) can be added without redesigning the domain.
- **Cons**: a use case that needs both side effects and complex pure
  logic must split into a `domain` helper plus an `application`
  orchestrator. Some duplication of "lift this pure value into Effect"
  boilerplate is unavoidable.

## Alternatives considered

- **Effect-everywhere** (no purity boundary): every domain function
  returns `Effect`. Cleaner once you're in it, but every test
  requires a layer composition, and pattern-matching on `_tag` becomes
  noisier.
- **Hexagonal without FCIS**: ports + adapters but no rule that the
  application core stays pure. Same drift problem we're trying to
  avoid.

## References

- Gary Bernhardt, *Boundaries* (2012).
- ADR-0008 (apps vs core layout).
- ADR-0017 (error handling).
- ADR-0019 (Schema as boundary parsing standard, separate file).
- ADR-0020 (port Tags, separate file).
