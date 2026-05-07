import { Schema } from "effect"
import { type BookingEvent, BookingEventSchema } from "./BookingEvent.js"

/**
 * Event upcasting as Kleisli composition. Each `Upcaster<From, To>`
 * is a morphism in the category of versioned event shapes; an
 * "upcaster chain" is the composite morphism `v0 → v1 → … → vN`
 * obtained by left-to-right composition.
 *
 * The chain is empty today (every variant is `version: 1`), but the
 * algebra is in place so a future v2 lands as
 * {@link composeUpcaster}(existingChain, v1ToV2) — no surgery in
 * `applyEvent`, no surgery in the read path.
 *
 * The decode at the end (`Schema.decodeUnknownSync(BookingEventSchema)`)
 * is the single arbiter of the final shape: unparsable events block
 * replay rather than silently producing malformed views.
 *
 * References — ADR-0032 (bitemporal events + version literal), the
 * natural extension of row-codec composition to event-codec
 * composition.
 */
export type Upcaster<From, To> = (event: From) => To

/**
 * Identity upcaster — the neutral element for {@link composeUpcaster}.
 * Applying an identity to a chain is a no-op, which matches the empty
 * chain's semantics on `upcastToLatest`.
 */
export const identityUpcaster =
  <A>(): Upcaster<A, A> =>
  (a) =>
    a

/**
 * Compose two upcasters left-to-right (`v_n → v_{n+1} → v_{n+2}`).
 * Associativity follows from function composition; identity is
 * {@link identityUpcaster}; the pair forms a category.
 */
export const composeUpcaster =
  <A, B, C>(f: Upcaster<A, B>, g: Upcaster<B, C>): Upcaster<A, C> =>
  (a) =>
    g(f(a))

/**
 * Versioned codec — the event payload schema paired with its
 * version literal. Reserved for the v2 landing: a registered chain
 * `[v1ToV2: Upcaster<V1, V2>]` is paired with a sequence of
 * `VersionedCodec` rows so the read path can dispatch on `version`,
 * decode against `Codec_v`, then walk the suffix of upcasters that
 * lifts to the latest.
 */
export type VersionedCodec<V extends number, A> = {
  readonly version: V
  readonly schema: Schema.Schema<A>
}

/**
 * Collapse an ordered chain of upcasters into one composite morphism
 * via {@link composeUpcaster}. The empty chain folds to
 * {@link identityUpcaster}, which is the categorical neutral element
 * — exactly the right semantics for "no version migration needed".
 */
export const upcastChain = (
  chain: readonly Upcaster<unknown, unknown>[],
): Upcaster<unknown, unknown> =>
  chain.reduce<Upcaster<unknown, unknown>>(composeUpcaster, identityUpcaster<unknown>())

/**
 * Ordered chain of `version N → version N+1` upcasters. Empty today;
 * extending it requires only appending a new entry — `upcastChain`
 * folds the addition automatically and `upcastToLatest` picks it up.
 */
const upcasterChain: readonly Upcaster<unknown, unknown>[] = []

const decodeBookingEvent = Schema.decodeUnknownSync(BookingEventSchema)

/**
 * Fold an unknown event payload through an explicit `chain` of
 * upcasters and decode the result against the latest
 * {@link BookingEventSchema}. Production callers go through
 * {@link upcastToLatest}; this lower-level entry point exists so
 * tests can inject a chain without the `let`-driven mutation that an
 * in-place stub would require.
 */
export const upcastWith = (
  chain: readonly Upcaster<unknown, unknown>[],
  raw: unknown,
): BookingEvent => decodeBookingEvent(upcastChain(chain)(raw))

/**
 * Fold an unknown event payload through the registered upcaster
 * chain and decode the result. Throws (via `decodeUnknownSync`) when
 * the resulting shape is not a valid latest-version event — that is
 * the read path's contract: unparsable events block replay rather
 * than silently producing malformed views.
 */
export const upcastToLatest = (raw: unknown): BookingEvent => upcastWith(upcasterChain, raw)
