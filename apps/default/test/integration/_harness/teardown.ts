import { abortAllDurableObjects } from "cloudflare:test"
import { afterAll } from "vitest"

afterAll(async () => {
  // Without an explicit DO abort the workers pool keeps the
  // Miniflare DO instances alive after the test file finishes;
  // the vitest runner observes the lingering connections and
  // never reaches its own exit. Calling `abortAllDurableObjects`
  // tears them down deterministically, so the runner shuts down
  // in a few hundred ms instead of hanging indefinitely.
  await abortAllDurableObjects()
})
