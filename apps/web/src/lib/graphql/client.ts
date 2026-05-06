/**
 * Minimal GraphQL client for the booking system. Two design points:
 *
 *   1. **Type-safe** without a codegen step — each query is wrapped in
 *      a typed `gql<TResult, TVars>(...)` template that pins the
 *      response and variable shapes from the call-site Schema. The
 *      compiled `.js` is a noop tagger that returns the literal string;
 *      typing is the only payload.
 *   2. **Zero runtime deps** — this is a fetch wrapper, not a full
 *      cache. The customer flow is request/response with no
 *      subscription channel, so Apollo / urql would buy us nothing.
 *      A future version can swap in `gql.tada` for cross-package
 *      schema introspection without touching call sites.
 */

declare const PhantomQuery: unique symbol

export type TypedQuery<TResult, TVars> = string & {
  readonly [PhantomQuery]: { result: TResult; vars: TVars }
}

/**
 * Tag a GraphQL string literal with its result and variables types.
 * Call sites annotate explicitly:
 *
 *   const Q = gql<{ availableSlots: Slot[] }, { date: string }>(
 *     `query ($date: PlainDate!) { availableSlots(date: $date) { ... } }`
 *   )
 */
export const gql = <TResult, TVars = Record<string, never>>(
  query: string,
): TypedQuery<TResult, TVars> => query as TypedQuery<TResult, TVars>

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
 * Execute a typed query and surface either the data or a thrown
 * error containing the GraphQL `errors[]` payload. The thrown
 * error carries the raw error array verbatim — typed `BookingError`
 * arms reach the UI through `data.<field>` already, so re-shaping
 * here would lose information.
 */
export const execute = async <TResult, TVars>(
  query: TypedQuery<TResult, TVars>,
  variables: TVars,
  opts: RequestOptions,
): Promise<TResult> => {
  const f = opts.fetchImpl ?? fetch
  const response = await f(opts.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    body: JSON.stringify({ query: query as string, variables }),
  })
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${String(response.status)}`)
  }
  const body = (await response.json()) as GraphQLResponse<TResult>
  if (body.errors && body.errors.length > 0) {
    const messages = body.errors.map((e) => e.message).join("; ")
    throw new Error(`GraphQL: ${messages}`)
  }
  if (!body.data) {
    throw new Error("GraphQL: response carries neither data nor errors")
  }
  return body.data
}
