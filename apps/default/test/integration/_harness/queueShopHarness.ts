import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import type { QueueShop } from "../../../src/server/durableObjects/QueueShop.js"

/**
 * Integration harness for the QueueShop DurableObject. Wraps the
 * `cloudflare:test` `runInDurableObject` helper so test bodies can
 * call DO instance methods directly + inspect persisted SQLite
 * state without going through the worker's HTTP boundary.
 *
 * The single-shop convention (idFromName("shop")) mirrors the
 * worker's runtime; tests that need isolation between cases call
 * `reset()` from `cloudflare:test` in `afterEach`.
 */

export const SHOP_NAME = "shop"

/**
 * Get the canonical QueueShop stub for the integration test
 * scope. `env.QUEUE_SHOP` flows through the worker's Env type via
 * the `cloudflare:test` runtime; the test typings declare
 * `Cloudflare.Env` as the surface but do not auto-augment from
 * `wrangler.toml` so we cast to our own Env shape.
 */
type TestEnv = { readonly QUEUE_SHOP: DurableObjectNamespace<QueueShop> }

export const getShopStub = (): DurableObjectStub<QueueShop> => {
  const e = env as unknown as TestEnv
  const id = e.QUEUE_SHOP.idFromName(SHOP_NAME)
  return e.QUEUE_SHOP.get(id)
}

/**
 * Run `callback` inside the QueueShop DO's isolate. Use this to
 * assert against `DurableObjectState.storage.sql` directly, or to
 * spy on private fields the public RPC surface does not expose.
 */
export const inShopDo = async <R>(
  callback: (instance: QueueShop, state: DurableObjectState) => R | Promise<R>,
): Promise<R> => {
  const stub = getShopStub()
  return runInDurableObject(stub, callback)
}

/**
 * Issue a fetch against the worker entrypoint (the `SELF` binding,
 * imported by the test file). Returns the Response so callers can
 * assert status + body.
 *
 * The harness deliberately does NOT inject the staff token here —
 * tests that need authentication build the headers themselves via
 * `jwtFixture.ts` (lands in C3) so the auth surface stays an
 * explicit input.
 */
export const callWorker = async (
  self: { fetch: (request: Request) => Promise<Response> },
  request: Request,
): Promise<Response> => self.fetch(request)
