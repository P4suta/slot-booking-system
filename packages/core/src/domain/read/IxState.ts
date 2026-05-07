import type { Brand } from "effect"
import type { BookingState, Held } from "../booking/Booking.js"
import type { BookingEvent } from "../events/BookingEvent.js"
import type { BookingView } from "./BookingView.js"
import { applyEvent, bookingProjection } from "./projection.js"

/**
 * Phase 3 / BI Indexed read projections (ADR-0043 draft).
 *
 * The runtime {@link applyEvent} carries five "wrong-state" guards
 * (Confirmed-onto-Cancelled, Reschedule-onto-Held, …) that no-op when
 * an event reaches a view it cannot legitimately mutate. The guards
 * are correct but they exist because the function signature loses
 * the read-side state at compile time — `(BookingView, BookingEvent)
 * → BookingView` cannot prove that the event is reachable from the
 * view.
 *
 * The Atkey-style indexed-monad shape closes that gap. A
 * {@link ViewT}<S> witnesses `view.state === S` at the type level;
 * {@link EventOnState}<S> selects only the events the read-side
 * projection accepts in state S; {@link NextOf}<S, E> computes the
 * resulting state. {@link applyEventTyped} narrows the runtime
 * `applyEvent` to those compile-time witnesses, so every type-aware
 * call site (typestate-driven test, future indexed replay) is
 * statically prevented from misapplying an event.
 *
 * The runtime function keeps its defensive guards: the event-
 * sourcing replay fold consumes a heterogeneous event stream and
 * cannot thread the per-step state through the `Array.reduce`
 * accumulator's invariant. The guards are the runtime witness of
 * the same relation this module encodes statically — type-side
 * narrowing for direct call sites, runtime safety for fold-driven
 * replay. {@link applyTyped} on the write side (`transitions.ts`)
 * is the same pattern.
 */

/**
 * Phantom-state-indexed read view. The runtime payload is a
 * {@link BookingView} (`Booking & Brand<"BookingView">`); the extra
 * brand `ViewT<S>` adds a state witness so `applyEventTyped` can
 * statically refuse wrong-state events.
 */
export type ViewT<S extends BookingState> = BookingView & Brand.Brand<`ViewT<${S}>`>

/**
 * Events the read-side projection accepts in state `S`. Mirrors the
 * adjacency table the runtime `applyEvent` no-ops outside of:
 *
 *   - `Held` → Confirmed / Cancelled (the Held event itself is the
 *     seed, never replayed onto an existing view).
 *   - `Confirmed` → Cancelled / Rescheduled / Completed / NoShow.
 *   - terminal (`Cancelled` / `Completed` / `NoShow`) → `never`.
 */
export type EventOnState<S extends BookingState> = S extends "Held"
  ? Extract<BookingEvent, { readonly type: "Confirmed" | "Cancelled" }>
  : S extends "Confirmed"
    ? Extract<BookingEvent, { readonly type: "Cancelled" | "Rescheduled" | "Completed" | "NoShow" }>
    : never

/**
 * Type-level transition table for the read-side projection. Reschedule
 * stays in `Confirmed`; every other reachable event lands in the
 * state matching its `type` literal.
 */
export type NextOf<S extends BookingState, E extends BookingEvent> = E extends {
  readonly type: "Confirmed"
}
  ? "Confirmed"
  : E extends { readonly type: "Cancelled" }
    ? "Cancelled"
    : E extends { readonly type: "Rescheduled" }
      ? "Confirmed"
      : E extends { readonly type: "Completed" }
        ? "Completed"
        : E extends { readonly type: "NoShow" }
          ? "NoShow"
          : S

/**
 * Indexed-monad / typestate variant of {@link applyEvent}. The (state,
 * event) pair is constrained at the type level — terminal `S` has
 * `EventOnState<S> = never`, which makes `applyEventTyped` statically
 * uncallable on a Cancelled / Completed / NoShow view. The runtime
 * body delegates to `applyEvent`; the success-side narrowing to
 * `ViewT<NextOf<S, E>>` is justified by the runtime
 * adjacency invariant (cross-validated in `projection.test.ts`'s
 * "applyEvent ↔ apply equivalence" suite plus the BI-8 lattice laws),
 * which the runtime guards make total over arbitrary inputs.
 */
export const applyEventTyped = <S extends BookingState, E extends EventOnState<S>>(
  view: ViewT<S>,
  event: E,
): ViewT<NextOf<S, E>> => applyEvent(view, event) as ViewT<NextOf<S, E>>

/**
 * Witness the read-side state on a {@link BookingView} — typically at
 * the boundary where a view freshly arrives (a Schema decode result,
 * or the seed of a replay). Like {@link import("./BookingView.js").asView},
 * the brand cast carries no runtime data.
 */
export const indexView = <S extends BookingState>(
  view: BookingView & { readonly state: S },
): ViewT<S> => view as unknown as ViewT<S>

/* -------------------------------------------------------------------------- */
/* Atkey indexed state monad                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Atkey-style indexed state monad. `IxState<S1, S2, A>` is a pure
 * morphism `ViewT<S1> → [A, ViewT<S2>]` — input state `S1`, output
 * state `S2`, carried value `A`. The two state indices encode the
 * read-side adjacency the runtime `applyEvent` no-ops outside of:
 * statically unknown event sequences erase to
 * `IxState<BookingState, BookingState, A>`, while statically-known
 * sequences carry their `S1 → S2` transition through `flatMap`.
 *
 * Monad laws (cross-validated by `IxState.test.ts`):
 *   - left identity:  `flatMap(pure(a), f) ≡ f(a)`
 *   - right identity: `flatMap(m, pure)   ≡ m`
 *   - associativity:  `flatMap(flatMap(m, f), g) ≡ flatMap(m, x => flatMap(f(x), g))`
 */
export type IxState<S1 extends BookingState, S2 extends BookingState, A> = (
  view: ViewT<S1>,
) => readonly [A, ViewT<S2>]

/** Pure / return — value `a`, state unchanged. */
export const pure =
  <S extends BookingState, A>(a: A): IxState<S, S, A> =>
  (view) =>
    [a, view] as const

/** Monadic bind. Threads the state output of `m` into the start of `f(a)`. */
export const flatMap =
  <S1 extends BookingState, S2 extends BookingState, S3 extends BookingState, A, B>(
    m: IxState<S1, S2, A>,
    f: (a: A) => IxState<S2, S3, B>,
  ): IxState<S1, S3, B> =>
  (view) => {
    const [a, mid] = m(view)
    return f(a)(mid)
  }

/** Run an IxState computation against a starting view. */
export const run = <S1 extends BookingState, S2 extends BookingState, A>(
  m: IxState<S1, S2, A>,
  initial: ViewT<S1>,
): readonly [A, ViewT<S2>] => m(initial)

/**
 * Lift one statically-typed event into an IxState step. The runtime
 * body delegates to {@link applyEventTyped}; the success-side index
 * transitions from `S` to `NextOf<S, E>` per the read-side adjacency
 * table.
 */
export const stepEvent =
  <S extends BookingState, E extends EventOnState<S>>(event: E): IxState<S, NextOf<S, E>, void> =>
  (view) =>
    [undefined, applyEventTyped(view, event)] as const

/**
 * Replay a heterogeneous event stream as an IxState catamorphism. The
 * static index erases to `BookingState` because the event sequence is
 * only known at runtime, but the runtime body is still the natural
 * fold over IxState — `pure(seed) >>= step(e_1) >>= step(e_2) >>= …`.
 *
 * Delegates to {@link bookingProjection} (the canonical
 * profunctor instance over `applyEvent`); future `dimap`-composed
 * projections share the same fold body.
 */
export const runReplay = (seed: Held, events: readonly BookingEvent[]): BookingView =>
  bookingProjection.run(seed, events)
