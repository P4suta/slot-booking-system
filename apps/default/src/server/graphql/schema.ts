import {
  type GraphQLFieldConfig,
  GraphQLObjectType,
  GraphQLSchema,
  lexicographicSortSchema,
} from "graphql"
import type { GraphQLContext } from "./context.js"
import {
  bookingErrorType,
  bookingSourceEnumType,
  instantScalar,
  makeEnvelopeRegistry,
  phoneLast4Scalar,
  plainDateScalar,
} from "./resolver.js"
import { availableSlotsQueryFields } from "./resolvers/availableSlots.js"
import { catalogQueryFields } from "./resolvers/catalog.js"
import { bookingMutationFields } from "./resolvers/mutations.js"
import { staffCatalogMutationFields } from "./resolvers/staffCatalog.js"

/**
 * PR#7 M18+M19 — assembled `GraphQLSchema` driven by raw `graphql-js`.
 *
 * Each resolver module exports a field-record factory; this module
 * spreads them into the `Query` and `Mutation` root objects. The
 * factories receive the shared `ErrorEnvelopeRegistry` (so the 16
 * `Mutation<Verb>Success / Mutation<Verb>Result` types are minted
 * once each) and otherwise stay independent — adding or removing a
 * resolver file touches at most two locations.
 *
 * `lexicographicSortSchema` normalises type, field, argument, union-
 * member, and enum-value ordering alphabetically. Pothos's
 * `builder.toSchema()` applied the same sort internally; preserving
 * it here is what keeps `apps/default/schema.graphql` byte-equal.
 *
 * The `types: [...]` extra-types parameter pins the few GraphQL types
 * that are reachable only through the union arms (BookingError +
 * scalars + enum) so they appear in the printed SDL even if no field
 * references them directly. graphql-js's reachability walk handles
 * the rest.
 */

const envelopeRegistry = makeEnvelopeRegistry()

const queryType = new GraphQLObjectType({
  name: "Query",
  fields: (): Record<string, GraphQLFieldConfig<unknown, GraphQLContext>> => ({
    ...catalogQueryFields(),
    ...availableSlotsQueryFields(),
  }),
})

const mutationType = new GraphQLObjectType({
  name: "Mutation",
  fields: (): Record<string, GraphQLFieldConfig<unknown, GraphQLContext>> => ({
    ...bookingMutationFields(envelopeRegistry),
    ...staffCatalogMutationFields(envelopeRegistry),
  }),
})

const baseSchema = new GraphQLSchema({
  query: queryType,
  mutation: mutationType,
  types: [
    bookingErrorType,
    bookingSourceEnumType,
    plainDateScalar,
    instantScalar,
    phoneLast4Scalar,
  ],
})

export const schema = lexicographicSortSchema(baseSchema)
