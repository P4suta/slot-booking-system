import { createYoga } from "graphql-yoga"
import type { GraphQLContext } from "./builder.js"
import { schema } from "./schema.js"

type Env = {
  readonly DB: D1Database
  readonly DAY_SCHEDULE: DurableObjectNamespace
}

/**
 * GraphQL Yoga adapter for Cloudflare Workers. The per-request
 * `context` factory carries the Cloudflare bindings (D1, the
 * `DaySchedule` DO namespace) so each resolver can route reads to D1
 * and writes to the per-day actor.
 *
 * The Effect runtime that mutations need (Clock, IdGenerator, …) lives
 * inside the DurableObject — resolvers only need to know how to reach
 * the right DO. This keeps the Worker entry tiny and centralises the
 * Layer composition in one place (`DaySchedule.layer(...)`).
 */
export const yoga = createYoga<Env, GraphQLContext>({
  schema,
  graphqlEndpoint: "/graphql",
  landingPage: false,
  graphiql: { defaultQuery: "{ __schema { types { name } } }" },
  context: (initial): GraphQLContext => ({
    env: { DB: initial.DB, DAY_SCHEDULE: initial.DAY_SCHEDULE },
    request: initial.request,
  }),
})
