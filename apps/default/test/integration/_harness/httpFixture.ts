import { SELF } from "cloudflare:test"

/**
 * HTTP integration fixture — wraps the worker's `SELF.fetch` so
 * test bodies can build typed Request objects against the real
 * worker entry without a network. The DO + D1 + rate-limit
 * bindings are wired through wrangler.toml so the fixture
 * exercises the same code path the production fetch handler does.
 *
 * The fixture intentionally does NOT layer in a recording logger
 * — the worker's WorkersLoggerLive emits to `console.*` which the
 * pool's stdio capture surfaces; tests that need to assert log
 * shape do so via the `cloudflare:test` console capture (lands as
 * needed in C5 + C8). This keeps the fixture small + focused on
 * the request/response contract.
 */

const ORIGIN = "http://example.com"

export type WorkerHandle = {
  readonly fetch: (request: Request) => Promise<Response>
}

/** Returns the typed worker handle the integration tests dispatch through. */
export const worker = (): WorkerHandle => SELF as unknown as WorkerHandle

export type RequestInit_ = {
  readonly method?: "GET" | "POST" | "OPTIONS"
  readonly headers?: HeadersInit
  readonly body?: BodyInit | null
  readonly upgrade?: boolean
}

export const buildRequest = (path: string, init: RequestInit_ = {}): Request => {
  const headers = new Headers(init.headers ?? {})
  if (init.upgrade === true) headers.set("Upgrade", "websocket")
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body ?? null,
  })
}

/**
 * One-shot request: build + dispatch + return Response. Most tests
 * use this; tests that need to inspect the Request before sending
 * call `buildRequest` + `worker().fetch` directly.
 */
export const send = async (path: string, init: RequestInit_ = {}): Promise<Response> => {
  return worker().fetch(buildRequest(path, init))
}

/** Parse JSON response body — throws if the body is empty / non-JSON. */
export const parseJson = async <T = unknown>(response: Response): Promise<T> =>
  (await response.json()) as T
