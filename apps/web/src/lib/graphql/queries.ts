import { gql } from "./client.js"

/**
 * Query / mutation literals used by the customer + staff flows. The
 * shape types live alongside the queries so the call-site reads
 * exactly the fields it asks for.
 *
 * The result types mirror the GraphQL schema's encoded form (ISO-8601
 * strings for Temporal, base64url strings for tokens). Higher-level
 * pages convert to display strings; we intentionally do not re-thread
 * Temporal through the page state to avoid pulling the polyfill into
 * every chunk.
 */

export type AvailableSlot = {
  readonly serviceId: string
  readonly start: string
  readonly end: string
  readonly providerId: string
  readonly resourceIds: readonly string[]
  readonly token: string
}

export const AvailableSlotsQuery = gql<
  { readonly availableSlots: readonly AvailableSlot[] },
  { readonly serviceId: string; readonly date: string }
>(/* GraphQL */ `
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

export type Service = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly durationMinutes: number
  readonly enabled: boolean
}

export const ServicesQuery = gql<{ readonly services: readonly Service[] }>(/* GraphQL */ `
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

export type BookingResult = {
  readonly __typename: "BookingResult"
  readonly bookingId: string
  readonly state: string
  readonly eventType: string
}

export type BookingErrorPayload = {
  readonly __typename: "BookingError"
  readonly tag: string
  readonly code: string
  readonly i18nKey: string
  readonly message: string
}

export type HoldOrError = BookingResult | BookingErrorPayload

export const HoldSlotMutation = gql<
  { readonly holdSlot: HoldOrError },
  {
    readonly date: string
    readonly slotToken: string
    readonly nameKana: string
    readonly phoneLast4: string
    readonly source: string
    readonly freeText?: string
  }
>(/* GraphQL */ `
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
      ... on BookingResult {
        bookingId
        state
        eventType
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

export const ConfirmBookingMutation = gql<
  { readonly confirmBooking: HoldOrError },
  { readonly date: string; readonly code: string; readonly phoneLast4: string }
>(/* GraphQL */ `
  mutation ConfirmBooking($date: PlainDate!, $code: String!, $phoneLast4: PhoneLast4!) {
    confirmBooking(date: $date, code: $code, phoneLast4: $phoneLast4) {
      __typename
      ... on BookingResult {
        bookingId
        state
        eventType
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

export const CancelBookingMutation = gql<
  { readonly cancelBooking: HoldOrError },
  {
    readonly date: string
    readonly code: string
    readonly phoneLast4: string
    readonly reason: string
  }
>(/* GraphQL */ `
  mutation CancelBooking(
    $date: PlainDate!
    $code: String!
    $phoneLast4: PhoneLast4!
    $reason: String!
  ) {
    cancelBooking(date: $date, code: $code, phoneLast4: $phoneLast4, reason: $reason) {
      __typename
      ... on BookingResult {
        bookingId
        state
        eventType
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
