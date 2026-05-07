# ADR-0044 — DO RPC envelope sanitiser

## Status

Phase 3 PR#8. **Accepted** — landed as commit 10 of plan
`validated-stargazing-karp.md`. Replaces the implicit "structured-clone
is enough" assumption ADR-0037 made and that `wrangler dev` revealed
to be wrong on `effect@4.0.0-beta.62`.

## Context

`apps/default/src/server/durableObjects/effectRpc/client.ts` builds
its DO RPC client through `RpcClient.makeNoSerialization`
(`effect/unstable/rpc`); the matching server side runs
`RpcServer.makeNoSerialization` inside `DaySchedule.dispatch`.
ADR-0037 chose this configuration because both sides live inside the
same `apps/default` worker bundle and the `RpcMessage.{FromClient,
FromServer}Encoded` shapes were documented as "pure JSON".

The first attempted local smoke run on `effect@4.0.0-beta.62`
demonstrated otherwise. `holdSlot` against `wrangler dev --local`
failed with:

```
DataCloneError: Could not serialize object of type "Object".
```

A printed dump of the message right before `stub.dispatch(message)`
revealed two structurally-clone-incompatible fields:

  - `id` / `requestId` — typed as `RpcMessage.RequestId =
    Branded<bigint, ...>`, a BigInt by spec. workerd's RPC
    serializer rejects naked BigInts on cross-isolate calls.
  - `headers` — a `Object.create(null)` (null-prototype) record
    that workerd's serializer also refuses.

The "pure JSON" claim is true at the schema level (the encoded
form is JSON-compatible), but the in-memory representation that
`makeNoSerialization` keeps to ferry across the transport keeps
the BigInt primitive and null-prototype object as-is. workerd
does not bridge them.

A full JSON-serialise/parse round-trip at the boundary would also
fix the symptom but at a category cost: `Exit` / `Cause` / Effect's
class-instance brands (the `_id` markers carrying the runtime
discriminator) survive `structuredClone` but not `JSON.parse`. The
`onFromClient` / `onFromServer` callbacks in
`makeNoSerialization` expect those instances on receipt and would
fail Schema validation against plain objects, with downstream
"Fiber.runLoop: Not a valid effect" defects.

## Decision

Introduce a *targeted shallow* sanitiser at the
`stub.dispatch(envelope)` boundary that converts only the two
fields workerd refuses, and leaves every other field by reference:

```ts
const BIGINT_SIGIL = "__bigint:"

export const sanitiseForStructuredClone = <T>(message: T): T => {
  if (typeof message !== "object" || message === null) return message
  const out = { ...(message as Record<string, unknown>) }
  // null-prototype `headers` → plain `{}`
  if (m.headers && typeof m.headers === "object") {
    out.headers = { ...(m.headers as Record<string, unknown>) }
  }
  // BigInt id / requestId → sigil string
  if (typeof m.id === "bigint") out.id = `${BIGINT_SIGIL}${m.id}`
  if (typeof m.requestId === "bigint")
    out.requestId = `${BIGINT_SIGIL}${m.requestId}`
  return out as T
}

export const desanitiseFromStructuredClone = <T>(message: T): T => {
  // Inverse: revive sigil strings on `id` / `requestId` back to BigInt.
}
```

The transform is composed at exactly two seams:

```text
                  client                          server
                                                  
          RpcClient.makeNoSerialization      RpcServer.makeNoSerialization
                    │                              │
                    ▼                              ▼
            FromClientEncoded               FromServerEncoded
                    │                              │
   ─── sanitise ─────▶  workerd dispatch  ────── desanitise ───
   ◀── desanitise ───                      ◀──── sanitise ───
```

Categorically, `sanitise ∘ desanitise = id` on the
`RpcMessage.{FromClient,FromServer}Encoded` codomain — a left-inverse
property pinned by `apps/default/test/effectRpc/transport.test.ts`.
The transform is the *minimum* natural transformation that lets
`makeNoSerialization`'s identity functor compose with workerd's
structured-clone hop without erasing Effect's class-instance
brands.

The sigil string is a tiny dialect rather than a structural marker
(`{__bigint__: "..."}`) because:

  - It survives JSON-clean structured clone trivially.
  - The reviver runs on every key via simple string-prefix check,
    so any future BigInt field on a sub-record (e.g. a future
    `Snowflake` payload field) would be picked up without changing
    this module.
  - The prefix is a short colon-bearing literal that Effect's
    internal RpcMessage fields never collide with by convention
    (their string fields are tag literals or ULID-like ids).

The `FromServer` response is sanitised in `DaySchedule.dispatch`
on the way out and desanitised on the client on receipt — the
same pair, applied in mirror.

## Consequences

**Wins**:

- Two known-clone-incompatible fields are normalised with one
  shallow transform pair on both sides. The BigInt id and the
  null-prototype `headers` field both survive the transport.
- Effect's `Exit` / `Cause` / Schema-encoded class instances inside
  `payload` are passed through by reference, preserving the
  `_id` discriminators the receiving runtime needs.
- The fix is contained: one new module
  (`effectRpc/transport.ts`), two callers (`client.ts` and
  `DaySchedule.dispatch.ts`) flipped to apply the sanitiser at the
  boundary. No domain or application layer code changes.
- The codec is pure, deterministic, and idempotent. Five vitest
  cases pin the shape contract.

**Trade-offs**:

- The wire-side string `"__bigint:N"` is a private dialect. A future
  Effect rpc message field carrying that exact string prefix would
  decode as a BigInt. The risk is documented in `transport.ts` and
  is mitigated by the convention that Effect's internal RpcMessage
  fields are short tag literals or ULID-like ids, neither of which
  start with `__bigint:`.
- The sanitiser walks only `headers`, `id`, `requestId`. If a
  future Effect rpc release adds a top-level field with another
  clone-incompatible type, the transform must be widened. The
  vitest case `is idempotent` plus the upcoming Miniflare
  integration suite (commit 11 of the same PR) is the canary —
  Miniflare exercises the actual cross-isolate path inside vitest,
  catching such drift before it reaches operator-facing smoke.

## Alternatives considered

1. **Switch to `RpcClient.make` + `RpcSerialization.layerJson`**.
   Effect's full-serialization mode emits JSON strings out of the
   box. Rejected for this PR because it requires writing an
   `effect/unstable/rpc` `Protocol` adapter for the DO transport
   (the built-in `makeProtocolHttp` / `makeProtocolSocket` /
   `makeProtocolWorker` helpers all assume HTTP / WebSocket /
   Worker threads, not Cloudflare's DO RPC syscall). The Protocol
   abstraction is the right long-term direction but the cost is
   larger than the targeted boundary fix this ADR locks in.
2. **Full JSON encode/decode at the seam**. Tried first and
   rejected: while `JSON.parse` happily revives Effect's `Exit` /
   `Cause` shapes structurally, the receiving `RpcServer.makeNo
   Serialization` does not run a Schema decode on its input — it
   expects the in-memory class instances `Effect` would normally
   construct. The downstream failure mode is
   `Fiber.runLoop: Not a valid effect: [object Object]` defects
   because the runtime tries to evaluate plain objects as Effects.
3. **Walk the message graph and convert BigInt to Number / String
   structurally**. Rejected because `RpcMessage.RequestId`'s
   identity is the BigInt — coercing to Number on encode would
   lose precision on long-running clients (request id increments
   forever) and we would lose the Effect Schema brand. The sigil
   pattern preserves both round-trip identity and BigInt arithmetic.

## References

- ADR-0017 — TaggedError + cause discipline
- ADR-0036 — Schema as source of truth
- ADR-0037 — `effect/unstable/rpc` for the DO transport
- ADR-0042 — RuntimeMode port (sibling env-indexed mechanism)
- ADR-0043 — ErrorRedaction port (sibling boundary-side codec)
