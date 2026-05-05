# 0019. Effect.Schema is the boundary-parsing standard

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: parsing, schema, effect

## Context

Phase 0 used hand-written `parseXxx(raw): Either<Brand, DomainError>`
smart constructors for every value object. The mechanism worked but
each new VO duplicated parser, brand, predicate, and (later) JSON
codec. Phase 1 will need:

- HTTP request decoding (boundary)
- D1 row → domain mapping
- GraphQL input/object → domain mapping (Step 17)
- fast-check arbitraries derived from the same schema
- Optional OpenAPI surface

Doing each of these by hand turns out to be five copies of the same
constraint with different syntaxes. We instead pin a single source of
truth.

## Decision

Every boundary-validated value declares an **Effect.Schema** that:

1. Returns the runtime decoder via `Schema.decodeUnknownEither`.
2. Carries the static type via `Schema.Schema.Type<typeof XxxSchema>`.
3. Carries the wire-format type via `Schema.Schema.Encoded<typeof XxxSchema>`.
4. Bridges `ParseError → DomainError` via the single helper
   `summarizeParse` in `domain/errors/fromParseError.ts`.
5. Brand-tags string/number primitives via `Schema.brand("…")`. The
   removed `domain/types/Brand.ts` phantom-symbol helper is replaced
   wholesale by Schema-derived brands; sibling-brand disjointness is
   verified by `test/type/Brands.test.ts` (Step 9).

Existing `parseXxx` smart constructors keep their signatures for
internal compatibility; their bodies become wrappers around
`Schema.decodeUnknownEither(XxxSchema)`.

For codecs that need a normalisation pass (`NameKana`, `FreeText`)
the Schema is a `Schema.transform(String, Branded, decode, encode)`
where `decode` runs the legacy normaliser before the brand's
filter chain. For `BookingCode` we get two parallel codecs
(`BookingCodeSchema: bigint ↔ branded`, and
`BookingCodeFromUserInputSchema: string ↔ branded`) so id generation
and human input both land in the same branded type.

For Temporal types the Schema declares a `string ↔ Temporal.X` codec
in `domain/types/Temporal.ts`, so Booking / BookingEvent /
BusinessHours / Closure / OpenWindow / TimeSlot / ProviderAbsence
all participate in JSON round-trip without a hand-rolled mapper.

## Consequences

- **Pros**: one declaration drives type, decoder, brand, and (Phase 1)
  GraphQL/JSON. The boundary becomes uniform and testable in isolation
  via `Schema.encodeSync(decode(input)) === input`.
- **Cons**: domain code now imports `effect/Schema`. Per ADR-0018
  this is allowed (Schema is treated as pure data, not as `Effect`
  the runtime). A reader unfamiliar with Effect Schema must learn
  it before adding a new VO; the templates in existing files
  (`PhoneLast4.ts` is the canonical pilot) keep the cost low.

## Alternatives considered

- **`zod`**: comparable feature surface, but moving away from the
  Effect ecosystem we already use for `Either` / `Data.TaggedError`
  would split the project's runtime in two.
- **Hand-rolled per VO** (Phase 0 status quo): rejected; cost of the
  five-way duplication scales with the codebase.

## References

- ADR-0017 (error handling) — `summarizeParse` lives in the same
  layer as the error classes it constructs.
- ADR-0018 (FCIS) — Schema counts as pure data; allowed in domain.
- Step 1 (Effect Schema for value objects), Step 5 (Schema-class for
  domain types), Step 6 (boundary Schema HoldSlotRequest).
