/**
 * Phase 3 / gql.tada scalar mapping. The `graphql-env.d.ts` file
 * (regenerated from `apps/default/schema.graphql`) augments the
 * `gql.tada` module with the introspection types but leaves custom
 * scalars (`PlainDate`, `Instant`, `PhoneLast4`) as `unknown`. Map
 * them to their wire shape here so result types carry the right
 * primitive on the customer side.
 *
 * Each scalar is an ISO-8601 string on the wire (`PlainDate` =
 * `YYYY-MM-DD`, `Instant` = `2026-05-05T09:30:00Z`, `PhoneLast4` =
 * `\d{4}`); the GraphQL boundary already validates them, so the
 * frontend reads them as `string`.
 */

import "./graphql-env.js"

declare module "gql.tada" {
  // gql.tada's setupSchema is declared as an interface upstream and
  // must be augmented with the same shape. typescript-eslint's
  // `consistent-type-definitions` rule prefers `type`, but this is
  // a module-augmentation hot path that has to use `interface`.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface setupSchema {
    scalars: {
      readonly PlainDate: string
      readonly Instant: string
      readonly PhoneLast4: string
    }
  }
}
