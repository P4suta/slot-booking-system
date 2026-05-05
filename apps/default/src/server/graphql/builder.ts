import SchemaBuilder from "@pothos/core"
import { GraphQLError } from "graphql"

/**
 * Pothos GraphQL schema builder. The Phase 0.5 surface only exposes a
 * read-side `availableSlots` query as proof of the toolchain wiring;
 * Phase 1 will layer Mutations (`holdSlot`, `confirmBooking`,
 * `cancelBooking`, `rescheduleBooking`) on top.
 *
 * Custom scalars / object types whose runtime decoder is an Effect
 * Schema use the `serialize / parseValue / parseLiteral` triplet to
 * delegate validation through the same `Schema.decodeUnknownEither`
 * path as the rest of the boundary, keeping ADR-0019 honest.
 *
 * `parseValue` receives `unknown` from Yoga (clients can send any
 * JSON), so each scalar's parser must narrow before passing the
 * string downstream. We refuse non-string inputs at the GraphQL
 * boundary rather than waiting for the use case to fail.
 */
export const builder = new SchemaBuilder<{
  Scalars: {
    PlainDate: { Input: string; Output: string }
    Instant: { Input: string; Output: string }
    PhoneLast4: { Input: string; Output: string }
  }
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
