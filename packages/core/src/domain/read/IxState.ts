import type { Brand } from "effect"
import type { BookingState } from "../booking/Booking.js"
import type { BookingEvent } from "../events/BookingEvent.js"
import type { BookingView } from "./BookingView.js"
import { applyEvent } from "./projection.js"

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
