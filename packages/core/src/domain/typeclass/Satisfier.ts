/**
 * Type class witnessing that a `capacity` (e.g. a Provider's skill set,
 * a Resource's type) is sufficient for a `need` (e.g. a Service's
 * `requiredSkills`, a Service's `requiredResourceTypes`).
 *
 * Two structurally identical instances are inhabited in the domain:
 *   - {@link providerSkillSatisfier}     — set-inclusion preorder
 *     (`need ⊆ capacity.skills`).
 *   - {@link resourceTypeSatisfier}      — set-membership
 *     (`capacity.type ∈ need`).
 *
 * Both are pure boolean-valued predicates with shape
 * `(capacity, need) → boolean`. The type class collapses the two
 * call-site repetitions of the same control flow without erasing the
 * semantic distinction (set inclusion ≠ set membership): each instance
 * carries the appropriate predicate body.
 */
export type Satisfier<C, N> = {
  readonly satisfies: (capacity: C, need: N) => boolean
}

/** Smart constructor — keeps the surface symmetric with Effect's idiom. */
export const make = <C, N>(satisfies: (capacity: C, need: N) => boolean): Satisfier<C, N> => ({
  satisfies,
})

/**
 * Set-inclusion primitive: `sub ⊆ sup` iff every element of `sub`
 * appears in `sup`. `O(|sub|)` worst case with early return on the
 * first missing member.
 *
 * This is the workhorse for {@link Satisfier} instances built around
 * required-set semantics (`Provider.skills`, future `Capability.scopes`).
 */
export const isSubsetOf = <T>(sub: ReadonlySet<T>, sup: ReadonlySet<T>): boolean => {
  for (const s of sub) {
    if (!sup.has(s)) return false
  }
  return true
}
