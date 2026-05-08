/**
 * Phase 3 PR#8 — boundary sanitiser for the Cloudflare DO RPC
 * transport.
 *
 * Background: `RpcClient.makeNoSerialization` (effect/unstable/rpc)
 * emits the request/response envelopes as in-memory objects whose
 * encoded form is JSON-shaped *in the limit*, but whose live
 * representation can carry workerd-incompatible values:
 *
 *   1. `id` / `requestId` typed as `RpcMessage.RequestId =
 *      Branded<bigint, ...>`, a BigInt by spec.
 *   2. `headers` built via `Object.create(null)` (no prototype).
 *   3. Sub-records inside `payload` likewise built with null
 *      prototypes by Effect's encoder, plus the response side
 *      carries `_id`-tagged class instances (`Exit` / `Cause` /
 *      `FailureCode`) that survive structured-clone but whose
 *      contained sub-fields can mix the same null-proto / BigInt
 *      issues at any nesting depth.
 *
 * Both fail with the same generic workerd error:
 *
 *   DataCloneError: Could not serialize object of type "Object".
 *
 * The fix: deep-walk the message graph and normalise the two
 * structural traits workerd refuses, leaving every other value by
 * value. Pure / deterministic / round-trip-id-preserving.
 *
 * Categorically: a single endofunctor on the
 * `RpcMessage.{FromClient,FromServer}Encoded` codomain whose
 * left-inverse `desanitise` revives the BigInt sigils. ADR-0044
 * walks through the design.
 */

const BIGINT_SIGIL = "__bigint:"

/**
 * Deep-walk the value and rewrite every object with an
 * unrecognisable prototype (null, cross-realm `Object.prototype`,
 * any custom class) to a fresh same-realm plain `{}`. workerd's RPC
 * serialiser identifies "plain object" by its OWN realm's
 * `Object.prototype`; an object built inside Effect's library
 * bundle has a different `Object.prototype` reference and is
 * rejected as `Could not serialize object of type "Object"`.
 *
 * BigInts are converted to the sigil string for symmetry with the
 * receiving-side reviver. Arrays are recursed into in place; their
 * `Array.prototype` identity is also realm-sensitive but workerd
 * accepts arrays detected via `Array.isArray` (which IS realm-safe).
 *
 * Visited via a fresh WeakSet to defend against pathological cycles
 * (none expected in well-formed `RpcMessage` payloads, but cheap
 * insurance).
 */
const transform = (value: unknown, encode: boolean, seen: WeakSet<object>): unknown => {
  if (encode && typeof value === "bigint") return `${BIGINT_SIGIL}${value.toString()}`
  if (!encode && typeof value === "string" && value.startsWith(BIGINT_SIGIL)) {
    return BigInt(value.slice(BIGINT_SIGIL.length))
  }
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((v) => transform(v, encode, seen))
  }
  // Always copy into a same-realm plain `{}` to defeat cross-realm
  // `Object.prototype` identity mismatches (Effect's library bundle
  // has its own realm and its objects' prototype !== this module's
  // `Object.prototype`, even though both are structurally
  // `Object.prototype`).
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    out[key] = transform((value as Record<string, unknown>)[key], encode, seen)
  }
  return out
}

/**
 * Outbound boundary transform: walk the message graph and rewrite
 * BigInt → sigil string and null-prototype objects → plain `{}`.
 * Plain objects and arrays are shallow-cloned (so the original
 * graph stays untouched); class instances keep their prototype but
 * their fields are recursed into.
 */
export const sanitiseForStructuredClone = <T>(message: T): T =>
  transform(message, true, new WeakSet()) as T

/**
 * Inbound boundary transform: revive BigInt sigil strings back to
 * BigInt. Pure inverse of {@link sanitiseForStructuredClone} on the
 * structural axis (nulls, prototypes, primitives) — only the BigInt
 * carrier is non-trivial.
 */
export const desanitiseFromStructuredClone = <T>(message: T): T =>
  transform(message, false, new WeakSet()) as T

/**
 * Project a `FromClientEncoded` request envelope onto OpenTelemetry
 * messaging + RPC semantic-convention attributes (commit 12).
 *
 * The envelope shape (`{ _tag: "Request", id, tag, payload, headers }`)
 * is the only structural input, so the projection is total: any
 * envelope without a recognisable `tag` falls back to `"unknown"`
 * rather than risking a missing-attribute span. Pure / deterministic /
 * no allocation beyond the result record.
 *
 * Why same-file as the sanitiser: both functions read the envelope's
 * topology (the sanitiser walks every field; this helper inspects the
 * `tag` field), so co-locating them keeps the envelope-shape knowledge
 * in one module instead of two coordinated ones.
 */
export const messagingAttributesFor = (
  envelope: unknown,
  destination: string,
): Readonly<Record<string, string>> => {
  const rpcMethod =
    typeof envelope === "object" && envelope !== null && "tag" in envelope
      ? String(envelope.tag)
      : "unknown"
  return {
    "messaging.system": "cloudflare.do",
    "messaging.operation.type": "send",
    "messaging.destination.name": destination,
    "rpc.system": "effect.unstable.rpc",
    "rpc.method": rpcMethod,
  }
}
