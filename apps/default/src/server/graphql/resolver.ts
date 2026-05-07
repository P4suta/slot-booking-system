import type { ErrorSeverity } from "@booking/core"
import {
  GraphQLEnumType,
  GraphQLError,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLUnionType,
} from "graphql"
import type { GraphQLContext } from "./context.js"
import { BookingError } from "./errors.js"

/**
 * PR#7 M17 — graphql-js resolver primitives that replace the Pothos
 * builder surface for `apps/default`. Companion to
 * {@link ../derive.ts | `derive.ts`} (the Schema → GraphQLOutputType
 * functor): this module provides the pieces the functor cannot
 * derive — the verb-indexed error envelope, the three custom
 * scalars, the booking-source enum, and the shared `BookingError`
 * GraphQL object.
 *
 * **Architectural framing.** The 16 mutation envelopes
 * (`Mutation<Verb>Result = BookingError | Mutation<Verb>Success`) are
 * the projection of `Result<BookingError, A>` onto the GraphQL
 * category. GraphQL forbids unions of scalars / non-objects, so the
 * success arm wraps `A` in a one-field projector `data: A!`. The
 * combinator below realises this projection once; resolver bodies
 * reduce to a Kleisli-style morphism `(args) → Effect → throw|return
 * → union arm`.
 *
 * **Byte-equal SDL constraint** (ADR-0041 §M17–M19 acceptance #3).
 * The descriptions, ordering, and shape of every type emitted here
 * mirror the Pothos baseline at `apps/default/schema.graphql`. Any
 * drift breaks the apps/web `gql.tada` typegen at
 * `apps/web/src/graphql-env.d.ts`.
 */

/* -------------------------------------------------------------------------- */
/* Custom scalars (PlainDate / Instant / PhoneLast4)                           */
/* -------------------------------------------------------------------------- */

const expectString =
  (typeName: string) =>
  (v: unknown): string => {
    if (typeof v !== "string") {
      throw new GraphQLError(`${typeName} must be a JSON string`)
    }
    return v
  }

/**
 * Identity-passthrough scalar factory. The Schema-side parsing
 * (`PlainDateSchema` etc.) runs inside the use cases, not at the
 * GraphQL boundary, so the wire shape is unconstrained beyond
 * "string". Brand-aware functor extension to push parse-on-decode to
 * this boundary is recorded as a deferred ADR-0041 follow-up.
 */
const stringScalar = (name: string, description: string): GraphQLScalarType =>
  new GraphQLScalarType({
    name,
    description,
    serialize: (v) => v,
    parseValue: expectString(name),
  })

export const plainDateScalar = stringScalar(
  "PlainDate",
  "ISO-8601 calendar date (e.g. 2026-05-05).",
)

export const instantScalar = stringScalar(
  "Instant",
  "ISO-8601 instant in UTC (e.g. 2026-05-05T09:30:00Z).",
)

export const phoneLast4Scalar = stringScalar(
  "PhoneLast4",
  "Last four digits of a phone number — exactly four ASCII digits.",
)

/* -------------------------------------------------------------------------- */
/* BookingSource enum                                                          */
/* -------------------------------------------------------------------------- */

/**
 * GraphQL enum that mirrors the domain `BookingSource` literal union
 * (`@booking/core`). Keeping the enum centralised lets every resolver
 * arg referencing `source: BookingSourceEnum` stay narrowed at parse
 * time — graphql-js refuses any value not in the four-literal set
 * before the resolver body runs.
 */
export const bookingSourceEnumType = new GraphQLEnumType({
  name: "BookingSource",
  description: "Origin of a booking — distinguishes self-service from operator-entered.",
  values: {
    online: { value: "online" },
    walkin: { value: "walkin" },
    phone: { value: "phone" },
    staff: { value: "staff" },
  },
})

/* -------------------------------------------------------------------------- */
/* BookingError union arm                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Brand symbol used to discriminate the `BookingError` union arm at
 * `resolveType` time. The combinator wraps a thrown {@link BookingError}
 * into a {@link BookingErrorEnvelope} plain object before returning it
 * to graphql-js — graphql-js short-circuits any resolver result that
 * is an `Error` instance into a field error (see `completeValue` in
 * `graphql/execution/execute.ts`), so we cannot return the raw
 * `BookingError` directly from the union resolver. The envelope is a
 * purely-structural wire carrier; the symbol is hoisted to the global
 * registry via `Symbol.for(...)` so cross-realm checks (vitest +
 * Node ESM dual-load corner cases) still discriminate correctly.
 */
const BOOKING_ERROR_BRAND: unique symbol = Symbol.for("@booking/BookingErrorEnvelope")

type BookingErrorEnvelope = {
  readonly [BOOKING_ERROR_BRAND]: true
  readonly tag: string
  readonly code: string
  readonly severity: ErrorSeverity
  readonly i18nKey: string
  readonly message: string
}

const isBookingErrorEnvelope = (v: unknown): v is BookingErrorEnvelope =>
  typeof v === "object" &&
  v !== null &&
  (v as Record<symbol, unknown>)[BOOKING_ERROR_BRAND] === true

const wrapBookingError = (e: BookingError): BookingErrorEnvelope => ({
  [BOOKING_ERROR_BRAND]: true,
  tag: e.tag,
  code: e.code,
  severity: e.severity,
  i18nKey: e.i18nKey,
  message: e.message,
})

export const bookingErrorType = new GraphQLObjectType({
  name: "BookingError",
  description:
    "A booking operation refused by the domain. Carries the discriminator tag, " +
    "stable error code, severity, and an i18n key the frontend can localize.",
  fields: () => ({
    tag: { type: GraphQLString },
    code: { type: GraphQLString },
    severity: { type: GraphQLString },
    i18nKey: { type: GraphQLString },
    message: { type: GraphQLString },
  }),
})

/* -------------------------------------------------------------------------- */
/* Error envelope combinator — Result<BookingError, A> projection              */
/* -------------------------------------------------------------------------- */

/**
 * Per-schema registry that dedupes the 16 envelope projections by
 * verb. Pass a single instance through the resolver field-record
 * factories so that a given `Mutation<Verb>Success` /
 * `Mutation<Verb>Result` pair is constructed once even if multiple
 * call sites quote the same verb.
 */
export type ErrorEnvelopeRegistry = {
  readonly successTypes: Map<string, GraphQLObjectType>
  readonly resultUnions: Map<string, GraphQLUnionType>
}

export const makeEnvelopeRegistry = (): ErrorEnvelopeRegistry => ({
  successTypes: new Map(),
  resultUnions: new Map(),
})

type ResolverBody = (args: Record<string, unknown>, ctx: GraphQLContext) => Promise<unknown>

type SuccessEnvelope = { readonly data: unknown }

/**
 * Build a `GraphQLFieldConfig` whose return type is the union
 * `Mutation<Verb>Result = BookingError | Mutation<Verb>Success
 * { data: <inner>! }`. The body resolver returns the encoded `inner`
 * shape on success or throws `BookingError` on a recognised failure;
 * the wrapper translates either branch onto the right union arm via
 * the `resolveType` callback. Member ordering — `BookingError` first,
 * `Mutation<Verb>Success` second — is the alphabetical lex-sort
 * order, matching the Pothos baseline byte-for-byte.
 *
 * `verb` is the categorical identity for the projection: it names the
 * generated success and result types nominally, since GraphQL nominal
 * typing requires a name per construction.
 */
export const errorEnvelope = (config: {
  readonly verb: string
  readonly inner: GraphQLOutputType
  readonly args: GraphQLFieldConfigArgumentMap
  readonly description?: string
  readonly body: ResolverBody
  readonly registry: ErrorEnvelopeRegistry
}): GraphQLFieldConfig<unknown, GraphQLContext> => {
  const { verb, inner, args, description, body, registry } = config
  const successName = `Mutation${verb}Success`
  const resultName = `Mutation${verb}Result`

  const successType =
    registry.successTypes.get(verb) ??
    new GraphQLObjectType({
      name: successName,
      fields: () => ({
        data: { type: new GraphQLNonNull(inner) },
      }),
    })
  registry.successTypes.set(verb, successType)

  const resultUnion =
    registry.resultUnions.get(verb) ??
    new GraphQLUnionType({
      name: resultName,
      types: () => [bookingErrorType, successType],
      resolveType: (v) => (isBookingErrorEnvelope(v) ? bookingErrorType.name : successType.name),
    })
  registry.resultUnions.set(verb, resultUnion)

  return {
    type: resultUnion,
    args,
    description,
    resolve: async (_root, rawArgs, ctx) => {
      try {
        const data = await body(rawArgs as Record<string, unknown>, ctx)
        const envelope: SuccessEnvelope = { data }
        return envelope
      } catch (e) {
        if (e instanceof BookingError) return wrapBookingError(e)
        throw e
      }
    },
  }
}
