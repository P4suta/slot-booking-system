import { Temporal } from "@js-temporal/polyfill"
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"

/**
 * Effect Schema declarations for the Temporal types we care about. Each
 * Schema is the canonical encoded form (ISO-8601 string) ↔ in-memory
 * Temporal object pair, derived through `Schema.decodeTo` overlays
 * with fallible getters. The decode side surfaces `Temporal.X.from`
 * failures as `SchemaIssue.InvalidValue` so `summarizeParse`
 * (`domain/errors/fromParseError.ts`) can render them uniformly.
 *
 * Production sinks (D1 columns, JSON HTTP bodies) speak the ISO-8601
 * string; the domain model stays in `Temporal` to keep arithmetic
 * total.
 *
 * Each declaration also carries a `toArbitrary` annotation so
 * `Schema.toArbitrary(schema)` (and our `schemaToArbitrary` helper)
 * synthesises a fast-check generator without any per-call site
 * shimming. Generators bound the search space to plausible business
 * values: PlainTime second precision (no nanos), PlainDate inside
 * 2000-2099 (epoch-day arithmetic stays in 32-bit range), Instant
 * within ±100 years of epoch.
 */

/* -------------------------------------------------------------------------- */
/* Type-only `is` Schemas (no codec). Exported so internal flat-row schemas    */
/* (BookingRow.ts) can compose against the Type level without forcing the     */
/* ISO-string encoding boundary on every nested Instant column.               */
/* -------------------------------------------------------------------------- */

export const InstantSelf = Schema.declare(
  (input: unknown): input is Temporal.Instant => input instanceof Temporal.Instant,
  {
    identifier: "Instant",
    toArbitrary: () => (fc) =>
      fc
        .integer({ min: -3_155_692_597_470, max: 3_155_692_597_470 })
        .map((ms) => Temporal.Instant.fromEpochMilliseconds(ms)),
  },
)
export const PlainDateSelf = Schema.declare(
  (input: unknown): input is Temporal.PlainDate => input instanceof Temporal.PlainDate,
  {
    identifier: "PlainDate",
    toArbitrary: () => (fc) =>
      fc
        .record({
          year: fc.integer({ min: 2000, max: 2099 }),
          month: fc.integer({ min: 1, max: 12 }),
          day: fc.integer({ min: 1, max: 28 }),
        })
        .map((parts) => Temporal.PlainDate.from(parts)),
  },
)
export const PlainTimeSelf = Schema.declare(
  (input: unknown): input is Temporal.PlainTime => input instanceof Temporal.PlainTime,
  {
    identifier: "PlainTime",
    toArbitrary: () => (fc) =>
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

const liftFromIso = <T>(ctor: (raw: string) => T, label: string) =>
  SchemaGetter.transformOrFail<T, string>((raw) =>
    Effect.try({
      try: () => ctor(raw),
      catch: () =>
        new SchemaIssue.InvalidValue(Option.some(raw), { message: `not a valid ${label}` }),
    }),
  )

const flattenToIso = <T extends { readonly toString: () => string }>() =>
  SchemaGetter.transform<string, T>((value) => value.toString())

export const InstantSchema = Schema.String.pipe(
  Schema.decodeTo(InstantSelf, {
    decode: liftFromIso((raw) => Temporal.Instant.from(raw), "Temporal.Instant"),
    encode: flattenToIso<Temporal.Instant>(),
  }),
)

export const PlainDateSchema = Schema.String.pipe(
  Schema.decodeTo(PlainDateSelf, {
    decode: liftFromIso((raw) => Temporal.PlainDate.from(raw), "Temporal.PlainDate"),
    encode: flattenToIso<Temporal.PlainDate>(),
  }),
)

export const PlainTimeSchema = Schema.String.pipe(
  Schema.decodeTo(PlainTimeSelf, {
    decode: liftFromIso((raw) => Temporal.PlainTime.from(raw), "Temporal.PlainTime"),
    encode: flattenToIso<Temporal.PlainTime>(),
  }),
)
