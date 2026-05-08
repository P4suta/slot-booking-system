import { describe, it } from "vitest"

// TODO(diagnose-train): unskip in F8 — depends on C11, which lands
// `{actor, action, traceId}` Cause annotations on the save path.
// Once that ships the property is: error tags emerge in a
// deterministic, schedule-independent order across concurrent Effect
// fibers running over the same aggregate.
describe("concurrency error-tag ordering (property)", () => {
  it.todo("error tag stream is invariant under fiber schedule")
})
