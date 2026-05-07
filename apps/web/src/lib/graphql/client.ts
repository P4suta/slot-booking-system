import type { TadaDocumentNode } from "gql.tada"
import { print } from "graphql"

/**
 * Phase 3 / gql.tada-driven GraphQL client. Each query is authored
 * via `graphql(...)` (see `./queries.ts`); gql.tada's TypeScript
 * type-system parser walks the document literal against the
 * introspected schema (`src/graphql-env.d.ts`, regenerated from
 * `apps/default/schema.graphql` on every build) and infers the
 * result + variables types directly. The fetch wrapper below is the
 * thin runtime around that — no cache, no subscription channel,
 * just request/response.
 *
 * Re-print the schema and regenerate the env d.ts via
 * `pnpm -F web run codegen`; the prebuild hooks in `dev` / `build` /
 * `check` already chain it.
 */

export type GraphQLError = {
  readonly message: string
  readonly extensions?: Readonly<Record<string, unknown>>
}

export type GraphQLResponse<T> = {
  readonly data?: T
  readonly errors?: readonly GraphQLError[]
}

export type RequestOptions = {
  readonly endpoint: string
  readonly headers?: Readonly<Record<string, string>>
  readonly fetchImpl?: typeof fetch
}

/**
 * Execute a typed `gql.tada` document and surface either the data or
 * a thrown error containing the GraphQL `errors[]` payload. The
 * thrown error carries the raw error array verbatim — typed
 * `BookingError` arms reach the UI through `data.<field>` already, so
 * re-shaping here would lose information.
 */
export const execute = async <Result, Variables>(
  query: TadaDocumentNode<Result, Variables>,
  variables: Variables,
  opts: RequestOptions,
): Promise<Result> => {
  const f = opts.fetchImpl ?? fetch
  const response = await f(opts.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    body: JSON.stringify({ query: print(query), variables }),
  })
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${String(response.status)}`)
  }
  const body = (await response.json()) as GraphQLResponse<Result>
  if (body.errors && body.errors.length > 0) {
    const messages = body.errors.map((e) => e.message).join("; ")
    throw new Error(`GraphQL: ${messages}`)
  }
  if (!body.data) {
    throw new Error("GraphQL: response carries neither data nor errors")
  }
  return body.data
}
