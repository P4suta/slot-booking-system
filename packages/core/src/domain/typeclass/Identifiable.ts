import { Equivalence, Order } from "effect"

/**
 * Type class witnessing that values of `A` carry a string identity. The
 * extracted id participates in equivalence, ordering, hashing, and
 * map-key derivations — the type class avoids hand-rolling the same
 * `(a, b) => a.id.localeCompare(b.id)` comparator at each call site.
 *
 * Mirrors Effect's `Equivalence` / `Order` modules: a struct of pure
 * accessors with companion derivations (no class hierarchy).
 */
export type Identifiable<A> = {
  readonly idOf: (a: A) => string
}

/** Smart constructor — keeps the surface symmetric with Effect's idiom. */
export const make = <A>(idOf: (a: A) => string): Identifiable<A> => ({ idOf })

/** Derived structural equivalence: `a ≡ b ⇔ idOf(a) = idOf(b)`. */
export const toEquivalence = <A>(I: Identifiable<A>): Equivalence.Equivalence<A> =>
  Equivalence.mapInput(Equivalence.String, I.idOf)

/** Derived total order on the id projection. */
export const toOrder = <A>(I: Identifiable<A>): Order.Order<A> =>
  Order.mapInput(Order.String, I.idOf)
