import { Schema } from "effect"
import {
  BookingIdSchema,
  ProviderIdSchema,
  ResourceIdSchema,
  ServiceIdSchema,
} from "../types/EntityId.js"
import { InstantSchema } from "../types/Temporal.js"
import { BookingCodeFromUserInputSchema as BookingCodeBrandSchema } from "../value-objects/BookingCode.js"
import { FreeTextSchema } from "../value-objects/FreeText.js"
import { NameKanaSchema } from "../value-objects/NameKana.js"
import { PhoneLast4Schema } from "../value-objects/PhoneLast4.js"
import { TimeSlotSchema } from "../value-objects/TimeSlot.js"

/* -------------------------------------------------------------------------- */
/* Discriminator enums                                                         */
/* -------------------------------------------------------------------------- */

/** Where the reservation came from. */
export const BookingSourceSchema = Schema.Literal("online", "walkin", "phone", "staff")
export type BookingSource = Schema.Schema.Type<typeof BookingSourceSchema>

/** Who initiated a state-changing action. */
export const ActorSchema = Schema.Literal("customer", "staff", "system")
export type Actor = Schema.Schema.Type<typeof ActorSchema>

/* -------------------------------------------------------------------------- */
/* Common-fields fragment                                                      */
/* -------------------------------------------------------------------------- */

const CommonFields = {
  id: BookingIdSchema,
  code: BookingCodeBrandSchema,
  serviceId: ServiceIdSchema,
  providerId: ProviderIdSchema,
  resourceIds: Schema.Array(ResourceIdSchema),
  slot: TimeSlotSchema,
  source: BookingSourceSchema,
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  freeText: Schema.NullOr(FreeTextSchema),
} as const

/* -------------------------------------------------------------------------- */
/* Variant Schemas                                                             */
/* -------------------------------------------------------------------------- */

export const HeldSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("Held"),
  heldAt: InstantSchema,
  expiresAt: InstantSchema,
})
export type Held = Schema.Schema.Type<typeof HeldSchema>

export const ConfirmedSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("Confirmed"),
  confirmedAt: InstantSchema,
})
export type Confirmed = Schema.Schema.Type<typeof ConfirmedSchema>

export const CancelledSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("Cancelled"),
  cancelledAt: InstantSchema,
  reason: Schema.String,
  cancelledBy: ActorSchema,
})
export type Cancelled = Schema.Schema.Type<typeof CancelledSchema>

export const CompletedSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("Completed"),
  completedAt: InstantSchema,
})
export type Completed = Schema.Schema.Type<typeof CompletedSchema>

export const NoShowSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("NoShow"),
  markedAt: InstantSchema,
  markedBy: ActorSchema,
})
export type NoShow = Schema.Schema.Type<typeof NoShowSchema>

/* -------------------------------------------------------------------------- */
/* Aggregate union                                                             */
/* -------------------------------------------------------------------------- */

export const BookingSchema = Schema.Union(
  HeldSchema,
  ConfirmedSchema,
  CancelledSchema,
  CompletedSchema,
  NoShowSchema,
)
export type Booking = Schema.Schema.Type<typeof BookingSchema>

export type BookingState = Booking["state"]

/** Common-fields helper used by entities, projections, and tests. */
export type BookingCommon = Pick<Booking, keyof typeof CommonFields>

/* -------------------------------------------------------------------------- */
/* Typestate refinements (Phase 2.0 / BI-1)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Phantom-narrowed `Booking` parameterised by its state. Lets the
 * indexed-monad-flavoured `applyTyped<S, K>` (in `transitions.ts`)
 * encode the (state, command) lattice at the call site: an illegal
 * call site (e.g. `Complete` on a `Held`) becomes a compile-time type
 * error, not a runtime `InvalidStateTransition` left.
 *
 * Usage at the boundary of pure transitions (`applyTyped`,
 * `requireScope`-style helpers) and in projections / read models that
 * must operate on a specific state. The runtime shape is identical
 * to `Booking` — `BookingT<S>` is purely a TypeScript refinement.
 */
export type BookingT<S extends BookingState> = Extract<Booking, { state: S }>

/**
 * The two non-terminal states that still consume capacity. Used by
 * `computeAvailableSlots` (booking masks) and the DurableObject
 * scheduler when filtering active holds. Equivalent to
 * `BookingT<"Held"> | BookingT<"Confirmed">`.
 */
export type Active = BookingT<"Held"> | BookingT<"Confirmed">

/**
 * Parametric type-guard factory. Calling `inState("Held")` yields a
 * `(b: Booking) => b is BookingT<"Held">` predicate. Adding a new
 * state to `BookingState` automatically extends the family — there is
 * no per-state hand-written guard to fall out of sync.
 */
export const inState =
  <S extends BookingState>(s: S) =>
  (b: Booking): b is BookingT<S> =>
    b.state === s

export const isHeld = inState("Held")
export const isConfirmed = inState("Confirmed")
export const isCancelled = inState("Cancelled")
export const isCompleted = inState("Completed")
export const isNoShow = inState("NoShow")

/**
 * Active = Held ∨ Confirmed. The disjunction is what
 * `computeAvailableSlots` needs to mask occupied minutes; carrying it
 * as a single guard keeps the slot-availability code site-free of
 * `b.state === "..."` literal comparisons.
 */
export const isActive = (b: Booking): b is Active => isHeld(b) || isConfirmed(b)
