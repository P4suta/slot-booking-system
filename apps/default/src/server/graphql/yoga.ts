import { createYoga } from "graphql-yoga"
import { schema } from "./schema.js"

/**
 * GraphQL Yoga adapter for Cloudflare Workers. Phase 0.5 binds it at
 * `/graphql`; Phase 1 will layer Cloudflare Access auth + a per-request
 * Effect runtime that provides `BookingRepository`, `Clock`,
 * `IdGenerator`, and `Logger` to resolvers.
 */
export const yoga = createYoga({
  schema,
  graphqlEndpoint: "/graphql",
  // Workers don't support GraphiQL (no browser context for the dev tool
  // in production), but the dev runtime serves it. Yoga handles the
  // detection automatically; we keep landingPage on so the GET / shows
  // a clickable link.
  landingPage: false,
  graphiql: { defaultQuery: "{ __schema { types { name } } }" },
})
