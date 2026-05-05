import SchemaBuilder from "@pothos/core"
import { GraphQLError } from "graphql"

/**
 * Pothos GraphQL schema builder.
 *
 * **Context shape** — every resolver gets `{ env, request }` so it can:
 *   - reach the per-day DurableObject (`env.DAY_SCHEDULE.idFromName(date)`)
 *     for write paths; the DO is the actor that serialises mutations
 *     within a single day (ADR-0005)
 *   - reach D1 directly (`env.DB`) for the long-retention read
 *     projections (ADR-0006)
 *
 * **Custom scalars** validate at the GraphQL boundary so the types
 * threaded into use cases are already narrowed (`PlainDate`, `Instant`
 * arrive as ISO-8601 strings; `PhoneLast4` arrives as four digits).
 * The same Effect Schema parsers run downstream inside the use cases,
 * but failing fast at the GraphQL parser keeps the error responses
 * uniform.
 */
export type GraphQLContext = {
  readonly env: {
    readonly DB: D1Database
    readonly DAY_SCHEDULE: DurableObjectNamespace
  }
  readonly request: Request
}

export const builder = new SchemaBuilder<{
  Scalars: {
    PlainDate: { Input: string; Output: string }
    Instant: { Input: string; Output: string }
    PhoneLast4: { Input: string; Output: string }
  }
  Context: GraphQLContext
}>({})

const expectString =
  (typeName: string) =>
  (v: unknown): string => {
    if (typeof v !== "string") {
      throw new GraphQLError(`${typeName} must be a JSON string`)
    }
    return v
  }

builder.scalarType("PlainDate", {
  description: "ISO-8601 calendar date (e.g. 2026-05-05).",
  serialize: (v) => v,
  parseValue: expectString("PlainDate"),
})

builder.scalarType("Instant", {
  description: "ISO-8601 instant in UTC (e.g. 2026-05-05T09:30:00Z).",
  serialize: (v) => v,
  parseValue: expectString("Instant"),
})

builder.scalarType("PhoneLast4", {
  description: "Last four digits of a phone number — exactly four ASCII digits.",
  serialize: (v) => v,
  parseValue: expectString("PhoneLast4"),
})
