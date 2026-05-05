import { Temporal } from "@js-temporal/polyfill"
import { ParseResult, Schema } from "effect"

/**
 * Effect Schema declarations for the Temporal types we care about. Each
 * Schema is the canonical encoded form (ISO-8601 string) ↔ in-memory
 * Temporal object pair, derived through `Schema.transformOrFail`.
 *
 * Production sinks (D1 columns, JSON HTTP bodies) speak the ISO-8601
 * string; the domain model stays in `Temporal` to keep arithmetic
 * total. Decoding catches the standard parse errors thrown by
 * `Temporal.X.from` and surfaces them as `ParseResult.Type` issues so
 * `summarizeParse` (`domain/errors/fromParseError.ts`) can render them
 * uniformly.
 */

/* -------------------------------------------------------------------------- */
/* Type-only `is` Schemas (no codec)                                          */
/* -------------------------------------------------------------------------- */

const InstantSelf = Schema.declare(
  (input: unknown): input is Temporal.Instant => input instanceof Temporal.Instant,
  { identifier: "Instant" },
)
const PlainDateSelf = Schema.declare(
  (input: unknown): input is Temporal.PlainDate => input instanceof Temporal.PlainDate,
  { identifier: "PlainDate" },
)
const PlainTimeSelf = Schema.declare(
  (input: unknown): input is Temporal.PlainTime => input instanceof Temporal.PlainTime,
  { identifier: "PlainTime" },
)

/* -------------------------------------------------------------------------- */
/* String ↔ Temporal codecs                                                    */
/* -------------------------------------------------------------------------- */

export const InstantSchema = Schema.transformOrFail(Schema.String, InstantSelf, {
  strict: true,
  decode: (raw, _opts, ast) => {
    try {
      return ParseResult.succeed(Temporal.Instant.from(raw))
    } catch {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "not a valid Temporal.Instant"))
    }
  },
  encode: (i) => ParseResult.succeed(i.toString()),
})

export const PlainDateSchema = Schema.transformOrFail(Schema.String, PlainDateSelf, {
  strict: true,
  decode: (raw, _opts, ast) => {
    try {
      return ParseResult.succeed(Temporal.PlainDate.from(raw))
    } catch {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "not a valid Temporal.PlainDate"))
    }
  },
  encode: (d) => ParseResult.succeed(d.toString()),
})

export const PlainTimeSchema = Schema.transformOrFail(Schema.String, PlainTimeSelf, {
  strict: true,
  decode: (raw, _opts, ast) => {
    try {
      return ParseResult.succeed(Temporal.PlainTime.from(raw))
    } catch {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "not a valid Temporal.PlainTime"))
    }
  },
  encode: (t) => ParseResult.succeed(t.toString()),
})
