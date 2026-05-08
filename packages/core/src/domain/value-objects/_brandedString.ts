import { type Brand, Result, Schema, SchemaGetter } from "effect"
import type { DomainError } from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

/**
 * Common shape for "branded ASCII / Unicode string with optional
 * pre-decode normalisation and a domain-specific error class".
 *
 * Five value objects share the body:
 *   - `Schema.String.check(...)` produces a refined string;
 *     the refinement is either a `Schema.isPattern(regex)` (so the
 *     `derive/algebra.ts` predicate fold can project it to a SQL
 *     `REGEXP` CHECK and a `fast-check` Arbitrary) or an opaque
 *     `Schema.makeFilter(predicate)` (for refinements with no
 *     regex shape — length-bounded NFC strings, code-point counts);
 *   - `Schema.brand(tag)` lifts the refinement to a phantom brand;
 *   - optional `normalize` runs through `Schema.decodeTo + SchemaGetter.transform`
 *     before the brand check, so the normalised form is what's
 *     branded;
 *   - `Schema.decodeUnknownResult` plus `summarizeParse` wraps the
 *     parse result in a tagged `DomainError` subtype.
 *
 * The combinator factors that body once. New string-shaped value
 * objects become one declaration:
 *
 * ```ts
 * const phone = brandedString({
 *   brand: "PhoneLast4",
 *   pattern: /^\d{4}$/,
 *   errorClass: InvalidPhoneLast4Error,
 * })
 * ```
 */
type BrandedStringCommon<B extends string, E extends DomainError> = {
  readonly brand: B
  /** Optional pre-decode normalisation (NFC/NFKC, trim, control-strip, …). */
  readonly normalize?: (s: string) => string
  /** Domain error constructor used to wrap the underlying parse failure. */
  readonly errorClass: new (input: {
    readonly reason: string
  }) => E
}

/**
 * Discriminated-union config: every call site supplies exactly one of
 * `pattern` (regex refinement, lifts via `Schema.isPattern` so the
 * `derive/algebra.ts` predicate fold projects it to SQL) or
 * `predicate` (opaque refinement, lifts via `Schema.makeFilter`).
 * Forbidding "neither" at the type level removes the otherwise
 * structurally-unreachable fallback arm in {@link brandedString}.
 */
type BrandedStringConfig<B extends string, E extends DomainError> =
  | (BrandedStringCommon<B, E> & {
      readonly pattern: RegExp
      readonly predicate?: undefined
    })
  | (BrandedStringCommon<B, E> & {
      readonly pattern?: undefined
      readonly predicate: (s: string) => boolean
    })

type BrandedString<B extends string> = string & Brand.Brand<B>

export type BrandedStringResult<B extends string> = {
  readonly schema: Schema.Codec<BrandedString<B>, string>
  readonly parse: (raw: unknown) => Result.Result<BrandedString<B>, DomainError>
}

export const brandedString = <B extends string, E extends DomainError>(
  config: BrandedStringConfig<B, E>,
): BrandedStringResult<B> => {
  // The discriminated union above guarantees exactly one of `pattern`
  // / `predicate` is defined; TS narrows the union into the matching
  // arm and the indexed reads below are total.
  const refined =
    config.pattern !== undefined
      ? Schema.String.check(Schema.isPattern(config.pattern))
      : Schema.String.check(Schema.makeFilter(config.predicate))

  const branded = refined.pipe(Schema.brand(config.brand)) as unknown as Schema.Codec<
    BrandedString<B>,
    string
  >

  const schema: Schema.Codec<BrandedString<B>, string> = config.normalize === undefined
    ? branded
    : Schema.String.pipe(
        Schema.decodeTo(branded, {
          decode: SchemaGetter.transform(config.normalize),
          encode: SchemaGetter.transform((s: string) => s),
        }),
      )

  const decode = Schema.decodeUnknownResult(schema)
  const parse = (raw: unknown): Result.Result<BrandedString<B>, DomainError> =>
    Result.mapError(decode(raw), (e) => new config.errorClass({ reason: summarizeParse(e) }))

  return { schema, parse }
}
