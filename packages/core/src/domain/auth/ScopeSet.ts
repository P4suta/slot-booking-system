import { Schema } from "effect"

/**
 * Permissioned action a staff member may issue while bearing the
 * capability. ADR-0055 fixes the scope universe at the single
 * `operate_queue` value — the staff command surface is the queue
 * dashboard (callNext / markServed / markNoShow / recall / cancel),
 * so a single bit suffices. The lattice machinery below stays
 * general so a future scope addition is one entry in
 * {@link ALL_SCOPES} and the bounded-semilattice laws hold unchanged.
 */
export const StaffScopeSchema = Schema.Literals(["operate_queue"])
export type StaffScope = Schema.Schema.Type<typeof StaffScopeSchema>

/**
 * Stable order over `StaffScope`. Decoded as a tuple so iteration is
 * deterministic — `toScopes` walks this order.
 */
export const ALL_SCOPES = ["operate_queue"] as const satisfies readonly StaffScope[]

/**
 * Bounded join-semilattice over `StaffScope`. The internal
 * representation is a `ReadonlySet<StaffScope>`; capability composition
 * is set union, scope containment is `Set.has` (O(1) either way).
 *
 * Lattice laws:
 *   - associative / commutative / idempotent under {@link merge}
 *   - {@link empty} is the identity for merge (⊥ ∪ x = x)
 *   - {@link full} is the absorbing element under intersection
 *
 * The internal representation is a plain `ReadonlySet<StaffScope>` —
 * correct, simple, and import-free.
 */
declare const ScopeSetBrand: unique symbol
export type ScopeSet = ReadonlySet<StaffScope> & { readonly [ScopeSetBrand]: never }

const lift = (s: ReadonlySet<StaffScope>): ScopeSet => s as ScopeSet

/** Bottom element ⊥. No scopes granted. */
export const empty = (): ScopeSet => lift(new Set<StaffScope>())

/** Top element ⊤. Every scope granted. */
export const full = (): ScopeSet => lift(new Set(ALL_SCOPES))

/** Materialise a singleton scope set. */
export const singleton = (s: StaffScope): ScopeSet => lift(new Set([s]))

/** Lift a wire-shape `NonEmptyArray<StaffScope>` (or any array) into the lattice. */
export const fromScopes = (scopes: readonly StaffScope[]): ScopeSet => lift(new Set(scopes))

/** Project the lattice element back to its canonical-order scope array. */
export const toScopes = (set: ScopeSet): readonly StaffScope[] =>
  ALL_SCOPES.filter((s) => set.has(s))

/** Join (set union) — the semilattice's only binary operation. */
export const merge = (a: ScopeSet, b: ScopeSet): ScopeSet => lift(new Set([...a, ...b]))

/** Containment query. */
export const hasScope = (set: ScopeSet, s: StaffScope): boolean => set.has(s)

/** Structural equality. */
export const equals = (a: ScopeSet, b: ScopeSet): boolean =>
  a.size === b.size && Array.from(a).every((s) => b.has(s))
