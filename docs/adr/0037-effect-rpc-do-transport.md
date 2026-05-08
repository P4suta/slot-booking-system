# 0037. `@effect/rpc` over a Cloudflare Durable Object dispatch method

- Status: superseded by [ADR-0050](./0050-queue-pivot.md) — the queue uses a plain DurableObjectNamespace stub method (`dispatch(action)`) for RPC; @effect/rpc + the cross-realm envelope sanitiser (ADR-0044) are no longer in the worker bundle.
- Superseded-By: ADR-0050
- Date: 2026-05-07
- Deciders: Yasunobu
- Tags: durable-object, rpc, effect-rpc, transport, schema-source-of-truth

## Context

Phase 0.7-β shipped `DaySchedule` with one async RPC method per
booking mutation, returning `Either<EncodedDomainError, EncodedResult>`
(ADR-0030). The shape was correct but ad-hoc:

- Each method's input wire schema (Phase 2.1 / BI-3) was a free-
  standing `Schema.Struct` with no machine-readable contract linking
  it to the corresponding use case.
- The four resolver call-sites carried `as Either.Either<...>` casts
  and a hand-rolled `unwrap` helper to turn `Right` into a value /
  `Left` into a `BookingError` throw.
- The error channel was an opaque `EncodedDomainError = { _tag,
  code, severity }` JSON shape, not a `Schema.Union` over the
  `errorClassRegistry` catalogue (Phase 2.0 / BI-2).
- Adding a new mutation required touching: the wire schema, the DO
  RPC method, the resolver, the type cast, the typed `unwrap`
  helper, and the error mapping — five sites for one feature.

## Decision

Adopt `@effect/rpc@0.75.x` as the **schema-driven RPC layer**, with
a single multiplexed `dispatch(envelope)` method on `DaySchedule`
that uses `RpcServer.makeNoSerialization` per request. The router
definition (`DayScheduleRouter`) is the authoritative protocol:

```ts
// router.ts (effectRpc/)
const HoldSlotRpc = Rpc.make("HoldSlot", {
  payload: Schema.encodedSchema(HoldSlotInputWireSchema),  // Phase 2.1 / BI-3
  success: BookingResultSchema,
  error:   Schema.Union(...errorClassRegistry),            // Phase 2.0 / BI-2
})
// ...four total
export const DayScheduleRouter = RpcGroup.make(
  HoldSlotRpc, ConfirmBookingRpc, CancelBookingRpc, RescheduleBookingRpc,
)
```

Resolver-side typed client:

```ts
// client.ts
const { client, write } = yield* RpcClient.makeNoSerialization(DayScheduleRouter, {
  supportsAck: false,
  onFromClient: ({ message }) => Effect.gen(function*() {
    const reply = yield* Effect.tryPromise(() => stub.dispatch(message))
    yield* (yield* Deferred.await(writeReady))(reply)
  }),
})
```

Resolver pattern:

```ts
return runRpcOrThrow(Effect.scoped(Effect.gen(function*() {
  const client = yield* makeDayScheduleClient(stub)
  return yield* client.HoldSlot(payload)  // Effect<Result, DomainError | RpcClientError>
})))
```

`runRpcOrThrow` lifts the typed `DomainError | RpcClientError`
channel onto the existing Pothos errors plugin's `BookingError` arm
— the GraphQL surface stays unchanged.

### Why `makeNoSerialization` rather than `make + Protocol Tag`

`make` wires a daemon-style server that consumes a `Protocol`
context tag and runs forever; pairing it with single-shot DO RPC
calls requires per-DO mailbox coordination + Deferred routing per
requestId, all of which is wasteful boilerplate when the request /
response shape is already 1:1 at the DO method boundary.

`makeNoSerialization` exposes `server.write(clientId, msg)` for
explicit drive — one envelope in, one envelope out — and the
inbound `FromClientEncoded` / outbound `FromServerEncoded` are
plain JS objects (`Schema.ExitEncoded` is the success / failure
shape), guaranteed structuredClone-safe. The DO-side cost is one
`Effect.scoped` per request to release the per-call `RpcServer`.

### Why the encoded payload schema (`Schema.encodedSchema(...)`)

The DO crosses Cloudflare's structuredClone envelope, which strips
brands and class instances. The router payload schema is therefore
the **encoded** view — plain JS — so the resolver constructs the
payload from raw GraphQL args without owning brand construction.
The DO handler still re-decodes via `decodeHoldSlotInput` etc.
(Phase 2.1 / BI-3), so domain values inside the use case stay
fully typed.

### Why the error channel is `Schema.Union(...errorClassRegistry)`

`errorClassRegistry` is the compile-time-enforced catalogue of every
`Schema.TaggedError` class in the project (Phase 2.0 / BI-2).
Surfacing it as the RPC error channel means: adding a new error
class registers it on every RPC's failure shape automatically,
with no schema duplication. The Pothos-side `BookingError` is the
on-the-wire union arm; its construction reads `codeOf(e)` /
`severityOf(e)` from the same registry.

## Consequences

### Positive

- Single source of truth for the RPC surface (router.ts).
- `rg 'as Either.Either<' apps/default/src` returns 0 — the resolver
  cast pattern is gone.
- Adding a new mutation = 1 `Rpc.make` + 1 handler entry + 1
  resolver. The wire codec, success schema, and error channel are
  already in place.
- The error channel auto-extends as the registry grows — no manual
  schema sync.

### Negative

- One additional dep (`@effect/rpc@~0.75.1`, ~6 KB after
  tree-shaking; size-limit on `@booking/core` unaffected since the
  RPC surface lives in `apps/default`).
- The forward-declaration trick in `client.ts` (`Deferred<WriteFn>`
  resolved post-construction) is non-obvious; a comment marks it
  as "chicken-and-egg between `onFromClient` and
  `makeNoSerialization`'s return".

### Carry-over

- Cloudflare DO crash recovery test using
  `@cloudflare/vitest-pool-workers` (`runInDurableObject` +
  `ctx.abort()`). Phase 2.8 verification line — to be added with
  the broader Miniflare integration suite (ADR-0036 carry-over
  registry).

## Alternatives considered

- **Custom `Protocol` Context.Tag implementation** (`make + Protocol`).
  Rejected — daemon model adds mailbox + per-request Deferred
  coordination on top of single-shot DO calls; no benefit over
  `makeNoSerialization` when the underlying transport is already
  request/response.
- **HTTP transport** (`layerProtocolHttp`). Rejected — DO supports
  HTTP via `fetch()`, but this routes through Worker → DO fetch
  bindings rather than the native typed-method surface, doubling
  the structuredClone hop and forcing JSON serialization.
- **Schema/router only** (option (c) in the BI-4 design dialogue).
  Rejected — gives up the typed `client.HoldSlot(payload)` API
  that's the proximate user-visible benefit of BI-4.

## References

- Plan: `~/.claude/plans/cosmic-conjuring-milner.md` Phase 2.8.
- Plan execution: `~/.claude/plans/bi-4-fluttering-codd.md`.
- ADR-0030 (legacy `Either<E, R>` shape) is now a special case of
  this ADR's success / error channel split.
- Phase 2.1 / BI-3 (Schema codec at the DO boundary) is the
  prerequisite — `inputCodec.ts`'s `*WireSchema` defs become the
  RPC payload schemas verbatim.
- Phase 2.0 / BI-2 (TaggedError registry) is the prerequisite —
  `errorClassRegistry` becomes the RPC error union verbatim.
