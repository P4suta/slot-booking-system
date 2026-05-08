import { graphql, type ResultOf } from "gql.tada"

/**
 * Phase 3 / gql.tada-typed query catalogue. Each `graphql(...)`
 * literal is parsed by gql.tada in the TypeScript type system
 * against the introspected schema (`src/graphql-env.d.ts`, regenerated
 * from `apps/default/schema.graphql`); the result and variable types
 * fall out of the literal text itself, so a typo in a field name or
 * a missing argument surfaces as a compile error rather than a
 * runtime `null`.
 *
 * Higher-level pages convert the encoded `Instant` / `PlainDate`
 * scalars (still typed as `string` on the wire) to display strings;
 * we intentionally do not re-thread Temporal through the page state
 * to avoid pulling the polyfill into every chunk.
 */

export const AvailableSlotsQuery = graphql(`
  query AvailableSlots($serviceId: String!, $date: PlainDate!) {
    availableSlots(serviceId: $serviceId, date: $date) {
      serviceId
      start
      end
      providerId
      resourceIds
      token
    }
  }
`)

export const ServicesQuery = graphql(`
  query Services {
    services {
      id
      name
      description
      durationMinutes
      enabled
    }
  }
`)

export const HoldSlotMutation = graphql(`
  mutation HoldSlot(
    $date: PlainDate!
    $slotToken: String!
    $nameKana: String!
    $phoneLast4: PhoneLast4!
    $source: String!
    $freeText: String
  ) {
    holdSlot(
      date: $date
      slotToken: $slotToken
      nameKana: $nameKana
      phoneLast4: $phoneLast4
      source: $source
      freeText: $freeText
    ) {
      __typename
      ... on MutationHoldSlotSuccess {
        data {
          bookingId
          state
          eventType
        }
      }
      ... on BookingError {
        tag
        code
        i18nKey
        message
      }
    }
  }
`)

export const ConfirmBookingMutation = graphql(`
  mutation ConfirmBooking($date: PlainDate!, $code: String!, $phoneLast4: PhoneLast4!) {
    confirmBooking(date: $date, code: $code, phoneLast4: $phoneLast4) {
      __typename
      ... on MutationConfirmBookingSuccess {
        data {
          bookingId
          state
          eventType
        }
      }
      ... on BookingError {
        tag
        code
        i18nKey
        message
      }
    }
  }
`)

export const CancelBookingMutation = graphql(`
  mutation CancelBooking(
    $date: PlainDate!
    $code: String!
    $phoneLast4: PhoneLast4!
    $reason: String!
  ) {
    cancelBooking(date: $date, code: $code, phoneLast4: $phoneLast4, reason: $reason) {
      __typename
      ... on MutationCancelBookingSuccess {
        data {
          bookingId
          state
          eventType
        }
      }
      ... on BookingError {
        tag
        code
        i18nKey
        message
      }
    }
  }
`)

/* -------------------------------------------------------------------------- */
/* Type re-exports — let call sites stay query-shape-agnostic.                */
/* -------------------------------------------------------------------------- */

type AvailableSlotsResult = NonNullable<ResultOf<typeof AvailableSlotsQuery>["availableSlots"]>
export type AvailableSlot = NonNullable<AvailableSlotsResult[number]>

type ServicesResult = NonNullable<ResultOf<typeof ServicesQuery>["services"]>
export type Service = NonNullable<ServicesResult[number]>
