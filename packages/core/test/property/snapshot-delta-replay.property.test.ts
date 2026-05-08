import { describe, it } from "vitest"

// TODO(diagnose-train): unskip in F8 — pin the monoid homomorphism
// `replay(xs ++ ys) deepEquals applyMany(replay(xs), ys)` so the
// K=200 snapshot+delta path is provably equivalent to a full event
// replay (see ADR-0059 for the projection contract).
describe("snapshot-delta replay homomorphism (property)", () => {
  it.todo("replay(xs ++ ys) deepEquals applyMany(replay(xs), ys)")
})
