import { Option } from "effect"

/**
 * Bipartite maximum-cardinality matching via Kuhn's algorithm
 * (augmenting-path search).
 *
 * Per-slot resource assignment in `computeAvailableSlots` matches
 * required resource types to available resource instances. The
 * matching produced is the witness that a slot is feasible — when
 * `matchBipartite` returns a perfect matching of size
 * `requiredTypes.length`, the slot can be served; otherwise it
 * cannot. ADR-0040 supersedes ADR-0034: the greedy first-match was
 * special-case-correct for the single-type-per-resource model but
 * leaves no general-purpose matching primitive in the codebase, and
 * any future generalisation (resources multi-tagged, fractional
 * capacities, weighted preferences) would replay the algorithm
 * design from scratch.
 *
 * Determinism — the matching tries augmenting paths in left-input
 * order and visits right-side candidates in their input order. Two
 * inputs that are sorted ID-ascending (the rest of `computeAvailableSlots`
 * already is) produce a deterministic matching across calls. Tie-breaks
 * therefore stay readable to operators who manually walk a day's
 * schedule.
 *
 * Complexity — O(V · E) for V left nodes and E edges, which on the
 * small instance sizes here (≤ 4 left nodes, ≤ a few dozen right
 * candidates) is operationally indistinguishable from the previous
 * greedy.
 *
 * References — Kuhn 1955 (Hungarian-method augmenting-path
 * formulation); Hopcroft-Karp's faster O(E√V) variant is overkill
 * for the per-slot bipartite sizes the booking domain produces.
 */

/**
 * Bipartite edges expressed as a left-indexed adjacency list. Right
 * nodes are referenced by index into the caller's right array, so
 * the algorithm is type-agnostic — domain types like `ResourceType`
 * and `ResourceId` collapse to numeric indices at the boundary.
 */
export type Adjacency = readonly (readonly number[])[]

/**
 * Result of {@link matchBipartite}. `assignment[L]` is
 * `Option.some(R)` when left node L is matched to right node R, and
 * `Option.none()` when L is unmatched. `cardinality` is the number
 * of matched pairs; the matching is perfect on the left side iff
 * `cardinality === assignment.length`.
 *
 * `Option<number>` over the bare `number | null` lets callers use
 * `Option.match` / `Option.isSome` and removes the off-by-one risk
 * from `assignment[i] === null` boundaries.
 */
export type Matching = {
  readonly assignment: readonly Option.Option<number>[]
  readonly cardinality: number
}

const tryAugment = (
  left: number,
  adj: Adjacency,
  matchR: (number | null)[],
  visited: boolean[],
): boolean => {
  for (const right of adj[left] ?? []) {
    if (visited[right] === true) continue
    visited[right] = true
    const owner = matchR[right]
    if (owner === null || owner === undefined || tryAugment(owner, adj, matchR, visited)) {
      matchR[right] = left
      return true
    }
  }
  return false
}

/**
 * Compute a maximum-cardinality matching of a bipartite graph given
 * as a left-indexed adjacency list. `rightSize` is the number of
 * right-side nodes (caller decides their meaning); the algorithm
 * makes no other assumption about right indices.
 *
 * Iteration order on left and right is preserved exactly: try left
 * node 0 first, walk its `adj[0]` neighbours in order, augment via
 * Kuhn's recursion. The matching is therefore a function of the
 * input order, which gives the determinism the slot-search
 * customer-facing flow relies on.
 */
export const matchBipartite = (adj: Adjacency, rightSize: number): Matching => {
  const matchR: (number | null)[] = new Array<number | null>(rightSize).fill(null)
  let cardinality = 0
  for (let left = 0; left < adj.length; left++) {
    const visited: boolean[] = new Array<boolean>(rightSize).fill(false)
    if (tryAugment(left, adj, matchR, visited)) cardinality++
  }
  const raw: (number | null)[] = new Array<number | null>(adj.length).fill(null)
  for (let right = 0; right < rightSize; right++) {
    const left = matchR[right]
    if (left !== null && left !== undefined) raw[left] = right
  }
  const assignment: readonly Option.Option<number>[] = raw.map((r) => Option.fromNullOr(r))
  return { assignment, cardinality }
}
