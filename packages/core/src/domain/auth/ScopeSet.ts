import { type Brand, Schema } from "effect"
import * as B from "../slot/Bitmap.js"

/**
 * Permissioned action the staff member may issue while bearing the
 * capability.
 *
 *   - `cancel` / `reschedule` / `complete` / `noshow` — per-booking
 *     state transitions (`Booking.apply` consults `hasScope`).
 *   - `manage_catalog` — create / update / delete on the six catalog
 *     entities. Granted to operators who own the deployment's day-to-day
 *     catalog edits; not granted to front-desk staff who only operate on
 *     bookings.
 *
 * Defined here (not in `Capability.ts`) because `ScopeSet` owns the bit
 * indexing — keeping the literal universe co-located with the lattice
 * keeps `Capability.ts ↔ ScopeSet.ts` acyclic.
 */
export const StaffScopeSchema = Schema.Literals([
  "cancel",
  "reschedule",
  "complete",
  "noshow",
  "manage_catalog",
])
export type StaffScope = Schema.Schema.Type<typeof StaffScopeSchema>

/**
 * Bounded join-semilattice over `StaffScope`. Each scope claims one bit
 * in a 5-bit `Bitmap`; capability composition is bitwise `or`, scope
 * containment is bitwise `isSet` (`O(1)` either way). The bitmap is the
 * **internal representation**: the wire shape (`StaffCapability.scopes:
 * NonEmptyArray<StaffScope>`) is unchanged — `fromScopes` lifts an array
 * into the lattice exactly when a bitmap operation is needed.
 *
 * Lattice laws:
 *   - associative / commutative / idempotent under {@link merge}
 *   - {@link empty} is the identity for merge (⊥ ∪ x = x)
 *   - {@link full} is the absorbing element under intersection (⊤ ∩ x = x)
 *
 * Reuses the existing `Bitmap` primitive (`domain/slot/Bitmap.ts`) so
 * the same algebraic structure backing `IntervalSet<G,D>` carries the
 * permission lattice.
 */
export type ScopeSet = B.Bitmap & Brand.Brand<"ScopeSet">

const SCOPE_BIT_INDEX: Record<StaffScope, number> = {
  cancel: 0,
  reschedule: 1,
  complete: 2,
  noshow: 3,
  manage_catalog: 4,
}

/**
 * Stable order over `StaffScope` mirroring {@link SCOPE_BIT_INDEX}.
 * Decoded as a tuple so iteration is deterministic.
 */
export const ALL_SCOPES = [
  "cancel",
  "reschedule",
  "complete",
  "noshow",
  "manage_catalog",
] as const satisfies readonly StaffScope[]

const SCOPE_COUNT = ALL_SCOPES.length

/** Bottom element ⊥. No scopes granted. */
export const empty = (): ScopeSet => B.empty(SCOPE_COUNT) as ScopeSet

/** Top element ⊤. Every scope granted. */
export const full = (): ScopeSet => B.full(SCOPE_COUNT) as ScopeSet

/** Materialise a singleton scope set. */
export const singleton = (s: StaffScope): ScopeSet => {
  const idx = SCOPE_BIT_INDEX[s]
  return B.setRange(B.empty(SCOPE_COUNT), idx, idx + 1) as ScopeSet
}

/** Lift a wire-shape `NonEmptyArray<StaffScope>` (or any array) into the lattice. */
export const fromScopes = (scopes: readonly StaffScope[]): ScopeSet =>
  scopes.reduce<B.Bitmap>(
    (acc, s) => B.setRange(acc, SCOPE_BIT_INDEX[s], SCOPE_BIT_INDEX[s] + 1),
    B.empty(SCOPE_COUNT),
  ) as ScopeSet

/** Project the lattice element back to its canonical-order scope array. */
export const toScopes = (set: ScopeSet): readonly StaffScope[] =>
  ALL_SCOPES.filter((s) => B.isSet(set, SCOPE_BIT_INDEX[s]))

/** Join (set union) — the semilattice's only binary operation. */
export const merge = (a: ScopeSet, b: ScopeSet): ScopeSet => B.or(a, b) as ScopeSet

/** Containment query. `O(1)` bitwise read. */
export const hasScope = (set: ScopeSet, s: StaffScope): boolean => B.isSet(set, SCOPE_BIT_INDEX[s])

/** Structural equality on the underlying bitmap. */
export const equals = (a: ScopeSet, b: ScopeSet): boolean => B.equals(a, b)
