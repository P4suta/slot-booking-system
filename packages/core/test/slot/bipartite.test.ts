import { Option } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { type Adjacency, matchBipartite } from "../../src/domain/slot/bipartite.js"

const arbAdjacency = (maxLeft = 6, maxRight = 6) =>
  fc
    .integer({ min: 0, max: maxLeft })
    .chain((leftSize) =>
      fc
        .integer({ min: 1, max: maxRight })
        .chain((rightSize) =>
          fc
            .array(
              fc.uniqueArray(fc.integer({ min: 0, max: rightSize - 1 }), { maxLength: rightSize }),
              { minLength: leftSize, maxLength: leftSize },
            )
            .map((adj): { adj: Adjacency; rightSize: number } => ({ adj, rightSize })),
        ),
    )

describe("matchBipartite — Option-typed assignment", () => {
  it("assignment length equals adj.length (property)", () => {
    fc.assert(
      fc.property(arbAdjacency(), ({ adj, rightSize }) => {
        const m = matchBipartite(adj, rightSize)
        return m.assignment.length === adj.length
      }),
    )
  })

  it("cardinality === assignment.filter(Option.isSome).length (property)", () => {
    fc.assert(
      fc.property(arbAdjacency(), ({ adj, rightSize }) => {
        const m = matchBipartite(adj, rightSize)
        const matched = m.assignment.filter(Option.isSome).length
        return matched === m.cardinality
      }),
    )
  })

  it("matched right indices are unique (property)", () => {
    fc.assert(
      fc.property(arbAdjacency(), ({ adj, rightSize }) => {
        const m = matchBipartite(adj, rightSize)
        const rights = m.assignment.flatMap((opt) => (Option.isSome(opt) ? [opt.value] : []))
        return new Set(rights).size === rights.length
      }),
    )
  })

  it("matched edges respect the adjacency graph (property)", () => {
    fc.assert(
      fc.property(arbAdjacency(), ({ adj, rightSize }) => {
        const m = matchBipartite(adj, rightSize)
        for (let l = 0; l < m.assignment.length; l++) {
          const opt = m.assignment[l]
          if (opt !== undefined && Option.isSome(opt)) {
            if (!(adj[l] ?? []).includes(opt.value)) return false
          }
        }
        return true
      }),
    )
  })

  it("empty bipartite graph yields empty matching", () => {
    const m = matchBipartite([], 0)
    expect(m.cardinality).toBe(0)
    expect(m.assignment.length).toBe(0)
  })

  it("perfect matching on disjoint pairs", () => {
    const adj: Adjacency = [[0], [1], [2]]
    const m = matchBipartite(adj, 3)
    expect(m.cardinality).toBe(3)
    const matched = m.assignment.flatMap((opt) => (Option.isSome(opt) ? [opt.value] : []))
    expect(matched).toEqual([0, 1, 2])
  })
})
