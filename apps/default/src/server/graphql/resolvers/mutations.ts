import { Effect } from "effect"
import {
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql"
import { type DecodedSlot, verifySlotToken } from "../../auth/slotToken.js"
import type { DaySchedule } from "../../durableObjects/DaySchedule.js"
import { makeDayScheduleClient } from "../../durableObjects/effectRpc/client.js"
import type { GraphQLContext } from "../context.js"
import { runRpcOrThrow } from "../effectRpcRunner.js"
import { BookingError } from "../errors.js"
import {
  bookingSourceEnumType,
  type ErrorEnvelopeRegistry,
  errorEnvelope,
  phoneLast4Scalar,
  plainDateScalar,
} from "../resolver.js"

/**
 * Booking mutations — `holdSlot`, `confirmBooking`, `cancelBooking`,
 * `rescheduleBooking`. Each resolver delegates to the per-day
 * `DaySchedule` Durable Object via direct RPC method invocation
 * (ADR-0030 / 2026 mainstream). Writes serialise inside the actor
 * model; the DO returns `Result<EncodedDomainError, EncodedResult>`,
 * the resolver narrows on `_tag` and either returns the encoded
 * success or throws a typed `BookingError`.
 *
 * **Phase 0.10 — slot tokens** — `holdSlot` and `rescheduleBooking`
 * accept an HMAC-signed `slotToken` instead of raw slot fields. The
 * resolver verifies the token (`SLOT_HMAC_SECRET`) before reaching
 * the DO RPC, so a tampered slot cannot bypass the world-consistency
 * check that justifies the brand on `AvailableSlot`. The DO body
 * still re-decodes through Effect Schema, but the resolver-side
 * verification is the boundary that turns a string into a trustworthy
 * value.
 *
 * **Customer auth** — `confirmBooking` / `cancelBooking` /
 * `rescheduleBooking` require `BookingCode + PhoneLast4`. The use
 * cases mint a `CustomerCapability` internally (ADR-0033), so the
 * resolver just forwards the fields without lifting the capability
 * itself. Staff-issued mutations route through a separate path
 * (`StaffCancelBooking` etc.) that bypasses the phone check; those
 * land in Phase 0.11 alongside the dashboard.
 */

type BookingResultShape = {
  readonly bookingId: string
  readonly state: string
  readonly eventType: string
}

const bookingResultType = new GraphQLObjectType({
  name: "BookingResult",
  description: "Outcome of a write to a booking; carries the new state and the emitted event.",
  fields: () => ({
    bookingId: { type: GraphQLString },
    state: { type: GraphQLString },
    eventType: { type: GraphQLString },
  }),
})

const dayDoFor = (env: GraphQLContext["env"], date: string): DurableObjectStub<DaySchedule> => {
  const id = env.DAY_SCHEDULE.idFromName(date)
  return env.DAY_SCHEDULE.get(id)
}

const verifyOrRefuse = async (env: GraphQLContext["env"], token: string): Promise<DecodedSlot> => {
  const slot = await verifySlotToken(env.SLOT_HMAC_SECRET, token)
  if (slot === null) {
    // Synthetic GraphQLErrorPayload — `InvalidSlotToken` is a wire-only
    // tag (no `errorClassRegistry` entry, since the verify step refuses
    // tampered tokens before any DomainError is even reachable).
    throw new BookingError({
      __typename: "InvalidSlotToken",
      code: "E_VAL_INVALID_SLOT_TOKEN",
      severity: "validation",
      i18nKey: "error.InvalidSlotToken" as never,
    })
  }
  return slot
}

const holdSlotArgs: GraphQLFieldConfigArgumentMap = {
  date: { type: new GraphQLNonNull(plainDateScalar) },
  slotToken: { type: new GraphQLNonNull(GraphQLString) },
  nameKana: { type: new GraphQLNonNull(GraphQLString) },
  phoneLast4: { type: new GraphQLNonNull(phoneLast4Scalar) },
  freeText: { type: GraphQLString },
  source: { type: new GraphQLNonNull(bookingSourceEnumType) },
}

const customerAuthArgs: GraphQLFieldConfigArgumentMap = {
  date: { type: new GraphQLNonNull(plainDateScalar) },
  code: { type: new GraphQLNonNull(GraphQLString) },
  phoneLast4: { type: new GraphQLNonNull(phoneLast4Scalar) },
}

const cancelArgs: GraphQLFieldConfigArgumentMap = {
  ...customerAuthArgs,
  reason: { type: new GraphQLNonNull(GraphQLString) },
}

const rescheduleArgs: GraphQLFieldConfigArgumentMap = {
  ...customerAuthArgs,
  newSlotToken: { type: new GraphQLNonNull(GraphQLString) },
}

type HoldSlotArgs = {
  readonly date: string
  readonly slotToken: string
  readonly nameKana: string
  readonly phoneLast4: string
  readonly freeText: string | null
  readonly source: "online" | "walkin" | "phone" | "staff"
}

type CustomerAuthArgs = {
  readonly date: string
  readonly code: string
  readonly phoneLast4: string
}

type CancelArgs = CustomerAuthArgs & { readonly reason: string }
type RescheduleArgs = CustomerAuthArgs & { readonly newSlotToken: string }

export const bookingMutationFields = (
  registry: ErrorEnvelopeRegistry,
): Record<string, GraphQLFieldConfig<unknown, GraphQLContext>> => ({
  holdSlot: errorEnvelope({
    verb: "HoldSlot",
    inner: bookingResultType,
    args: holdSlotArgs,
    description:
      "Place a 5-minute hold on the slot identified by the HMAC-signed `slotToken`. " +
      "The token is one of the values returned by `availableSlots` — see ADR-0033 / " +
      "Phase 0.7-α5 for the brand justification.",
    registry,
    body: async (rawArgs, ctx): Promise<BookingResultShape> => {
      const args = rawArgs as unknown as HoldSlotArgs
      const slot = await verifyOrRefuse(ctx.env, args.slotToken)
      const stub = dayDoFor(ctx.env, args.date)
      return runRpcOrThrow(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeDayScheduleClient(stub)
            return yield* client.HoldSlot({
              slot: {
                serviceId: slot.serviceId,
                providerId: slot.providerId,
                resourceIds: slot.resourceIds,
                start: slot.start,
                end: slot.end,
              },
              nameKana: args.nameKana,
              phoneLast4: args.phoneLast4,
              freeText: args.freeText ?? null,
              source: args.source,
            })
          }),
        ),
      )
    },
  }),

  confirmBooking: errorEnvelope({
    verb: "ConfirmBooking",
    inner: bookingResultType,
    args: customerAuthArgs,
    description:
      "Promote a Held booking to Confirmed. Customer auth = `BookingCode + " +
      "PhoneLast4`, lifted to a `CustomerCapability` inside the use case.",
    registry,
    body: async (rawArgs, ctx): Promise<BookingResultShape> => {
      const args = rawArgs as unknown as CustomerAuthArgs
      const stub = dayDoFor(ctx.env, args.date)
      return runRpcOrThrow(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeDayScheduleClient(stub)
            return yield* client.ConfirmBooking({
              code: args.code,
              phoneLast4: args.phoneLast4,
            })
          }),
        ),
      )
    },
  }),

  cancelBooking: errorEnvelope({
    verb: "CancelBooking",
    inner: bookingResultType,
    args: cancelArgs,
    description:
      "Cancel a Held or Confirmed booking. Customer auth = `BookingCode + " +
      "PhoneLast4`, lifted to a `CustomerCapability` inside the use case.",
    registry,
    body: async (rawArgs, ctx): Promise<BookingResultShape> => {
      const args = rawArgs as unknown as CancelArgs
      const stub = dayDoFor(ctx.env, args.date)
      return runRpcOrThrow(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeDayScheduleClient(stub)
            return yield* client.CancelBooking({
              code: args.code,
              phoneLast4: args.phoneLast4,
              reason: args.reason,
            })
          }),
        ),
      )
    },
  }),

  rescheduleBooking: errorEnvelope({
    verb: "RescheduleBooking",
    inner: bookingResultType,
    args: rescheduleArgs,
    description:
      "Move a Confirmed booking to a different slot on the same day. " +
      "`newSlotToken` is the HMAC-signed envelope from a fresh `availableSlots` " +
      "lookup — the verification path is identical to `holdSlot`.",
    registry,
    body: async (rawArgs, ctx): Promise<BookingResultShape> => {
      const args = rawArgs as unknown as RescheduleArgs
      const slot = await verifyOrRefuse(ctx.env, args.newSlotToken)
      const stub = dayDoFor(ctx.env, args.date)
      return runRpcOrThrow(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeDayScheduleClient(stub)
            return yield* client.RescheduleBooking({
              code: args.code,
              phoneLast4: args.phoneLast4,
              newSlot: {
                serviceId: slot.serviceId,
                providerId: slot.providerId,
                resourceIds: slot.resourceIds,
                start: slot.start,
                end: slot.end,
              },
            })
          }),
        ),
      )
    },
  }),
})
