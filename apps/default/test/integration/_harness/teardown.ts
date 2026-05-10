import { abortAllDurableObjects, reset } from "cloudflare:test"
import { afterAll, afterEach } from "vitest"

afterEach(async () => {
  // Per-test storage reset so the next case starts from an empty
  // shop. The integration suites that stage their own fixture
  // (queueWebSocket, queueFlow.property) call `reset()` themselves
  // before populating; this is the safety net for the suites that
  // forget.
  await reset()
})

afterAll(async () => {
  // Without an explicit DO abort the workers pool keeps the
  // Miniflare DO instances alive after the test file finishes;
  // the vitest runner observes the lingering connections and
  // never reaches its own exit. Calling `abortAllDurableObjects`
  // tears them down deterministically, so the runner shuts down
  // in a few hundred ms instead of hanging indefinitely.
  await abortAllDurableObjects()
})
