/**
 * Phase 3 PR#8 — boundary sanitiser for the Cloudflare DO RPC
 * transport.
 *
 * Background: `RpcClient.makeNoSerialization` (effect/unstable/rpc)
 * emits the request/response envelopes as in-memory objects. Two
 * fields fall outside Cloudflare DO RPC's `structuredClone` accept
 * set:
 *
 *   1. `id` / `requestId` — typed as `RpcMessage.RequestId =
 *      Branded<bigint, ...>`, a BigInt by spec. workerd's RPC
 *      serializer rejects naked BigInts on cross-isolate calls.
 *   2. `headers` — created via `Object.create(null)` (no prototype),
 *      which workerd also refuses.
 *
 * The fix is targeted: shallow-copy `headers` into a plain-prototype
 * `{}` and convert the BigInt `id` / `requestId` to a sigil string
 * (decoded back on the receiving side). Everything else passes
 * through unchanged so Effect's class-instance brands (`_id` markers
 * on `Exit` / `Cause` etc.) survive the cross-isolate hop, which a
 * full-JSON serialise/parse round-trip would erase.
 *
 * Categorically: this is the smallest natural transformation on the
 * `RpcMessage.{FromClient,FromServer}Encoded` codomain that makes
 * `makeNoSerialization`'s identity functor compose with workerd's
 * structured-clone hop. ADR-0044 walks through the design.
 */

const BIGINT_SIGIL = "__bigint:"

const encodeId = (v: unknown): unknown =>
  typeof v === "bigint" ? `${BIGINT_SIGIL}${v.toString()}` : v

const decodeId = (v: unknown): unknown =>
  typeof v === "string" && v.startsWith(BIGINT_SIGIL) ? BigInt(v.slice(BIGINT_SIGIL.length)) : v

type Sanitisable = {
  readonly headers?: unknown
  readonly id?: unknown
  readonly requestId?: unknown
}

/**
 * Replace null-prototype `headers` with a plain-prototype shallow
 * copy, and convert BigInt `id` / `requestId` to the documented
 * sigil string. Other fields pass through by reference (Effect's
 * class instances inside `payload` / `exit` etc. keep their
 * prototypes).
 *
 * Pure / shallow / idempotent — calling twice produces the same
 * result.
 */
export const sanitiseForStructuredClone = <T>(message: T): T => {
  if (typeof message !== "object" || message === null) return message
  const m = message as Sanitisable
  const needsHeaders =
    m.headers !== undefined && m.headers !== null && typeof m.headers === "object"
  const needsId = typeof m.id === "bigint"
  const needsRequestId = typeof m.requestId === "bigint"
  if (!needsHeaders && !needsId && !needsRequestId) return message
  const out = { ...(message as Record<string, unknown>) }
  if (needsHeaders) {
    out.headers = { ...(m.headers as Record<string, unknown>) }
  }
  if (needsId) out.id = encodeId(m.id)
  if (needsRequestId) out.requestId = encodeId(m.requestId)
  return out as T
}

/**
 * Inverse: re-hydrate the BigInt fields the receiving side needs.
 * The headers shape is already a plain object after the sanitiser,
 * which the receiving Effect runtime accepts.
 */
export const desanitiseFromStructuredClone = <T>(message: T): T => {
  if (typeof message !== "object" || message === null) return message
  const m = message as Sanitisable
  const out = { ...(message as Record<string, unknown>) }
  if (m.id !== undefined) out.id = decodeId(m.id)
  if (m.requestId !== undefined) out.requestId = decodeId(m.requestId)
  return out as T
}
