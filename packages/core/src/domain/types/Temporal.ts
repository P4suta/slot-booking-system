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
 *
 * Each declaration also carries an `arbitrary` annotation so
 * `Arbitrary.make(schema)` (and our `schemaToArbitrary` helper)
 * synthesises a fast-check generator without any per-call site
 * shimming. Generators bound the search space to plausible business
 * values: PlainTime second precision (no nanos), PlainDate inside
 * 2000-2099 (epoch-day arithmetic stays in 32-bit range), Instant
 * within ±100 years of epoch.
 *
 * The annotation is the docs-prescribed shape:
 *   `arbitrary: () => (fc: typeof FastCheck) => Arbitrary<T>`
 * (Effect Schema "Generating Arbitraries" section).
 */

/* -------------------------------------------------------------------------- */
/* Type-only `is` Schemas (no codec)                                          */
/* -------------------------------------------------------------------------- */

const InstantSelf = Schema.declare(
  (input: unknown): input is Temporal.Instant => input instanceof Temporal.Instant,
  {
    identifier: "Instant",
    arbitrary: () => (fc) =>
      fc
        .integer({ min: -3_155_692_597_470, max: 3_155_692_597_470 })
        .map((ms) => Temporal.Instant.fromEpochMilliseconds(ms)),
  },
)
const PlainDateSelf = Schema.declare(
  (input: unknown): input is Temporal.PlainDate => input instanceof Temporal.PlainDate,
  {
    identifier: "PlainDate",
    arbitrary: () => (fc) =>
      fc
        .record({
          year: fc.integer({ min: 2000, max: 2099 }),
          month: fc.integer({ min: 1, max: 12 }),
          day: fc.integer({ min: 1, max: 28 }),
        })
        .map((parts) => Temporal.PlainDate.from(parts)),
  },
)
const PlainTimeSelf = Schema.declare(
  (input: unknown): input is Temporal.PlainTime => input instanceof Temporal.PlainTime,
  {
    identifier: "PlainTime",
    arbitrary: () => (fc) =>
      fc
        .record({
          hour: fc.integer({ min: 0, max: 23 }),
          minute: fc.integer({ min: 0, max: 59 }),
          second: fc.integer({ min: 0, max: 59 }),
        })
        .map((parts) => Temporal.PlainTime.from(parts)),
  },
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
