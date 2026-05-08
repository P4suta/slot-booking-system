import { graphql } from "gql.tada"
import { describe, expect, it, vi } from "vitest"
import { execute, type GraphQLError, type GraphQLResponse } from "../../src/lib/graphql/client.js"

/**
 * Phase 3 PR#8 / commit 13 — pin the apps/web GraphQL client wrapper's
 * three behavioural axes:
 *
 * 1. Success path — the typed `data` object lifts straight through.
 * 2. GraphQL `errors[]` path — concatenated messages bubble up via
 *    `Error`, no silent `data: undefined` leak.
 * 3. HTTP non-OK path — the status code surfaces in the thrown error.
 *
 * The wrapper is the single ingress for every Svelte page's GraphQL
 * call; a regression here would silently land on every customer
 * route. Mocking `fetch` per-test keeps the assertions hermetic.
 */

const NoopQuery = graphql(`
  query NoopQuery {
    services {
      id
    }
  }
`)

const mockFetch = (response: Response): typeof fetch => {
  return vi.fn().mockResolvedValue(response)
}

const jsonResponse = <T>(
  body: GraphQLResponse<T>,
  init: { readonly status?: number } = {},
): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  })

describe("apps/web execute() — GraphQL fetch wrapper", () => {
  it("returns the typed data object on success", async () => {
    const fetchImpl = mockFetch(jsonResponse({ data: { services: [{ id: "svc_1" }] } }))
    const result = await execute(
      NoopQuery,
      {},
      { endpoint: "https://api.example/graphql", fetchImpl },
    )
    expect(result).toEqual({ services: [{ id: "svc_1" }] })
  })

  it("propagates the GraphQL endpoint + body shape verbatim", async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({ data: { services: [] } }))
    await execute(NoopQuery, {}, { endpoint: "https://api.example/graphql", fetchImpl: spy })
    expect(spy).toHaveBeenCalledOnce()
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.example/graphql")
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({ "content-type": "application/json" })
    const parsed = JSON.parse(init.body as string) as { query: string; variables: unknown }
    expect(parsed.query).toMatch(/query NoopQuery/)
    expect(parsed.variables).toEqual({})
  })

  it("merges custom headers into the request without dropping content-type", async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({ data: { services: [] } }))
    await execute(
      NoopQuery,
      {},
      {
        endpoint: "https://api.example/graphql",
        headers: { authorization: "Bearer xyz" },
        fetchImpl: spy,
      },
    )
    const [, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({
      authorization: "Bearer xyz",
      "content-type": "application/json",
    })
  })

  it("throws when the GraphQL response carries a non-empty errors[]", async () => {
    const errors: readonly GraphQLError[] = [{ message: "boom" }, { message: "kaboom" }]
    const fetchImpl = mockFetch(jsonResponse({ errors }))
    await expect(
      execute(NoopQuery, {}, { endpoint: "https://api.example/graphql", fetchImpl }),
    ).rejects.toThrow(/GraphQL: boom; kaboom/)
  })

  it("throws on HTTP non-OK responses with the status code surfaced", async () => {
    const fetchImpl = mockFetch(jsonResponse({}, { status: 500 }))
    await expect(
      execute(NoopQuery, {}, { endpoint: "https://api.example/graphql", fetchImpl }),
    ).rejects.toThrow(/GraphQL HTTP 500/)
  })

  it("throws when the response carries neither data nor errors", async () => {
    const fetchImpl = mockFetch(jsonResponse({}))
    await expect(
      execute(NoopQuery, {}, { endpoint: "https://api.example/graphql", fetchImpl }),
    ).rejects.toThrow(/neither data nor errors/)
  })

  it("falls back to global fetch when no fetchImpl is provided", async () => {
    const original = globalThis.fetch
    const spy = vi.fn().mockResolvedValue(jsonResponse({ data: { services: [] } }))
    globalThis.fetch = spy
    try {
      await execute(NoopQuery, {}, { endpoint: "https://api.example/graphql" })
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      globalThis.fetch = original
    }
  })
})
