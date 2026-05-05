import SchemaBuilder from "@pothos/core"

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
 */
export const builder = new SchemaBuilder<{
  Scalars: {
    PlainDate: { Input: string; Output: string }
    Instant: { Input: string; Output: string }
    PhoneLast4: { Input: string; Output: string }
  }
}>({})

builder.scalarType("PlainDate", {
  description: "ISO-8601 calendar date (e.g. 2026-05-05).",
  serialize: (v) => String(v),
  parseValue: (v) => String(v),
})

builder.scalarType("Instant", {
  description: "ISO-8601 instant in UTC (e.g. 2026-05-05T09:30:00Z).",
  serialize: (v) => String(v),
  parseValue: (v) => String(v),
})

builder.scalarType("PhoneLast4", {
  description: "Last four digits of a phone number — exactly four ASCII digits.",
  serialize: (v) => String(v),
  parseValue: (v) => String(v),
})
