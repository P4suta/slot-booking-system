# 0030. DurableObject RPC methods returning `Either<E, R>`

- Status: superseded by [ADR-0037](./0037-effect-rpc-do-transport.md)
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: durable-object, rpc, error-handling

> **Note (2026-05-08, ADR-0039):** Effect 4 migration renamed `Either` to
> `Result`. ADR-0037 is now the active transport ADR; the wire-channel split
> below survives but is expressed as `Result.Result<R, E>` in code.

## Context

Phase 0.5 routed mutations through `DaySchedule.fetch(req)` with a
JSON envelope (`{ kind, args }`). The pattern duplicated request
parsing on every method, lost RPC-method-level type safety, and
forced the client to construct envelopes by hand.

Cloudflare Workers' DurableObject runtime supports typed RPC
methods (2026 mainstream): the binding's `DurableObjectNamespace<T>`
generic threads `T`'s public method signatures through to the
caller.

## Decision

Each booking mutation is an `async` method on `DaySchedule`:

```ts
async holdSlot(input: HoldSlotInput): Promise<Either<EncodedHoldResult, EncodedDomainError>>
```

The return type is `Either` rather than a thrown exception because
Cloudflare's `structuredClone` boundary strips custom Error subclass
fields — throwing across the RPC would erase the discriminated
union shape of `DomainError`. The explicit Either channel preserves
`{ _tag, code, severity }`; the resolver narrows on `_tag` and
either re-encodes the success or lifts the failure onto a typed
`BookingError` (Pothos errors plugin, ADR pending in Phase 0.7).

## Consequences

- **Pros**: end-to-end type safety from GraphQL resolver to use
  case; no hand-written envelope parser; failures stay narrowable.
- **Cons**: branded domain types (`AvailableSlot` carrying
  `Temporal.ZonedDateTime`) cross the wire as plain JSON via
  structuredClone — the DO body re-decodes through Effect Schema
  before reaching the use case, but the TS signature shows the
  branded shape and resolvers cast at the wire boundary. Phase
  0.10's HMAC-signed slot tokens close that loop.

## References

- ADR-0028 (DO SQL storage)
- `apps/default/src/server/durableObjects/DaySchedule.ts`
- `apps/default/src/server/graphql/resolvers/mutations.ts`
