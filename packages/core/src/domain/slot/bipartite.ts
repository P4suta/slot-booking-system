import { Option } from "effect"

/**
 * Bipartite maximum-cardinality matching via Hopcroft-Karp's algorithm.
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
 * Determinism — left nodes are enumerated in input order, BFS
 * dequeues in FIFO order, and DFS visits right-side candidates in
 * input order. Two inputs that are sorted ID-ascending (the rest of
 * `computeAvailableSlots` already is) produce a deterministic
 * matching across calls. Tie-breaks therefore stay readable to
 * operators who manually walk a day's schedule.
 *
 * Complexity — `O(E·√V)` for V left nodes and E edges (Hopcroft-Karp
 * 1973). On the small instance sizes the booking domain produces
 * (≤ 4 left, ~dozens right) the asymptotic improvement is
 * imperceptible, but the algorithm gives the codebase a
 * production-grade matching primitive should the bipartite scale
 * grow (resources multi-tagged, batch optimisation across a day,
 * etc.).
 *
 * References — Hopcroft & Karp, "An n^{5/2} Algorithm for Maximum
 * Matchings in Bipartite Graphs" (1973). The Kuhn (1955)
 * augmenting-path predecessor that previously inhabited this file
 * is structurally a single-phase HK; this rewrite keeps the same
 * `Adjacency → Matching` signature and tie-break ordering.
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

const NIL = -1
const INF = Number.POSITIVE_INFINITY

/**
 * BFS phase. Builds a level graph from currently-unmatched left
 * nodes outward, recording at `dist[u]` the distance from any free
 * left source to `u`. Returns `true` iff at least one augmenting
 * path of finite length exists from an unmatched left to an
 * unmatched right.
 */
const hopcroftKarpBfs = (
  adj: Adjacency,
  pairU: readonly number[],
  pairV: readonly number[],
  dist: number[],
): boolean => {
  const queue: number[] = []
  for (let u = 0; u < adj.length; u++) {
    if (pairU[u] === NIL) {
      dist[u] = 0
      queue.push(u)
    } else {
      dist[u] = INF
    }
  }
  let foundAugmenting = false
  let head = 0
  while (head < queue.length) {
    const u = queue[head]
    head++
    if (u === undefined) continue
    const du = dist[u] ?? INF
    for (const v of adj[u] ?? []) {
      const owner = pairV[v]
      if (owner === undefined || owner === NIL) {
        foundAugmenting = true
        continue
      }
      if ((dist[owner] ?? INF) === INF) {
        dist[owner] = du + 1
        queue.push(owner)
      }
    }
  }
  return foundAugmenting
}

/**
 * DFS phase. Walks an augmenting path from `u` through layers of
 * strictly-increasing `dist` and flips the matched edges along the
 * way. Right-side neighbours are visited in input order, preserving
 * deterministic tie-breaking.
 */
const hopcroftKarpDfs = (
  u: number,
  adj: Adjacency,
  pairU: number[],
  pairV: number[],
  dist: number[],
): boolean => {
  const du = dist[u] ?? INF
  for (const v of adj[u] ?? []) {
    const owner = pairV[v]
    const isFree = owner === undefined || owner === NIL
    const ownerDist = isFree ? du + 1 : (dist[owner] ?? INF)
    if (ownerDist !== du + 1) continue
    if (isFree || hopcroftKarpDfs(owner, adj, pairU, pairV, dist)) {
      pairU[u] = v
      pairV[v] = u
      return true
    }
  }
  dist[u] = INF
  return false
}

/**
 * Compute a maximum-cardinality matching of a bipartite graph given
 * as a left-indexed adjacency list. `rightSize` is the number of
 * right-side nodes (caller decides their meaning); the algorithm
 * makes no other assumption about right indices.
 *
 * Iteration order on left and right is preserved exactly: BFS
 * dequeues in FIFO order, DFS visits each `adj[u]` in input order.
 * The matching is therefore a function of the input order, which
 * gives the determinism the slot-search customer-facing flow
 * relies on.
 */
export const matchBipartite = (adj: Adjacency, rightSize: number): Matching => {
  const pairU: number[] = new Array<number>(adj.length).fill(NIL)
  const pairV: number[] = new Array<number>(rightSize).fill(NIL)
  const dist: number[] = new Array<number>(adj.length).fill(INF)
  let cardinality = 0
  while (hopcroftKarpBfs(adj, pairU, pairV, dist)) {
    for (let u = 0; u < adj.length; u++) {
      if (pairU[u] === NIL && hopcroftKarpDfs(u, adj, pairU, pairV, dist)) cardinality++
    }
  }
  const assignment: readonly Option.Option<number>[] = pairU.map((v) =>
    v === NIL ? Option.none() : Option.some(v),
  )
  return { assignment, cardinality }
}
