import { Effect } from "effect"
import { type DecodedSlot, verifySlotToken } from "../../auth/slotToken.js"
import type { DaySchedule } from "../../durableObjects/DaySchedule.js"
import { makeDayScheduleClient } from "../../durableObjects/effectRpc/client.js"
import { BookingSourceEnum, builder, type GraphQLContext } from "../builder.js"
import { runRpcOrThrow } from "../effectRpcRunner.js"
import { BookingError } from "../errors.js"

/**
 * Booking mutations — `holdSlot`, `confirmBooking`, `cancelBooking`,
 * `rescheduleBooking`. Each resolver delegates to the per-day
 * `DaySchedule` Durable Object via direct RPC method invocation
 * (ADR-0030 / 2026 mainstream). Writes serialise inside the actor
 * model; the DO returns `Either<EncodedDomainError, EncodedResult>`,
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

const BookingResultType = builder.objectRef<BookingResultShape>("BookingResult").implement({
  description: "Outcome of a write to a booking; carries the new state and the emitted event.",
  fields: (t) => ({
    bookingId: t.exposeString("bookingId"),
    state: t.exposeString("state"),
    eventType: t.exposeString("eventType"),
  }),
})

const dayDoFor = (env: GraphQLContext["env"], date: string): DurableObjectStub<DaySchedule> => {
  const id = env.DAY_SCHEDULE.idFromName(date)
  return env.DAY_SCHEDULE.get(id)
}

const verifyOrRefuse = async (env: GraphQLContext["env"], token: string): Promise<DecodedSlot> => {
  const slot = await verifySlotToken(env.SLOT_HMAC_SECRET, token)
  if (slot === null) {
    throw new BookingError({
      _tag: "InvalidSlotToken",
      code: "E_VAL_INVALID_SLOT_TOKEN",
      severity: "validation",
    })
  }
  return slot
}

builder.mutationType({
  fields: (t) => ({
    holdSlot: t.field({
      type: BookingResultType,
      errors: { types: [BookingError] },
      description:
        "Place a 5-minute hold on the slot identified by the HMAC-signed `slotToken`. " +
        "The token is one of the values returned by `availableSlots` — see ADR-0033 / " +
        "Phase 0.7-α5 for the brand justification.",
      args: {
        date: t.arg({ type: "PlainDate", required: true }),
        slotToken: t.arg.string({ required: true }),
        nameKana: t.arg.string({ required: true }),
        phoneLast4: t.arg({ type: "PhoneLast4", required: true }),
        freeText: t.arg.string({ required: false }),
        source: t.arg({ type: BookingSourceEnum, required: true }),
      },
      resolve: async (_root, args, ctx) => {
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

    confirmBooking: t.field({
      type: BookingResultType,
      errors: { types: [BookingError] },
      description:
        "Promote a Held booking to Confirmed. Customer auth = `BookingCode + " +
        "PhoneLast4`, lifted to a `CustomerCapability` inside the use case.",
      args: {
        date: t.arg({ type: "PlainDate", required: true }),
        code: t.arg.string({ required: true }),
        phoneLast4: t.arg({ type: "PhoneLast4", required: true }),
      },
      resolve: async (_root, args, ctx) => {
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

    cancelBooking: t.field({
      type: BookingResultType,
      errors: { types: [BookingError] },
      description:
        "Cancel a Held or Confirmed booking. Customer auth = `BookingCode + " +
        "PhoneLast4`, lifted to a `CustomerCapability` inside the use case.",
      args: {
        date: t.arg({ type: "PlainDate", required: true }),
        code: t.arg.string({ required: true }),
        phoneLast4: t.arg({ type: "PhoneLast4", required: true }),
        reason: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
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

    rescheduleBooking: t.field({
      type: BookingResultType,
      errors: { types: [BookingError] },
      description:
        "Move a Confirmed booking to a different slot on the same day. " +
        "`newSlotToken` is the HMAC-signed envelope from a fresh `availableSlots` " +
        "lookup — the verification path is identical to `holdSlot`.",
      args: {
        date: t.arg({ type: "PlainDate", required: true }),
        code: t.arg.string({ required: true }),
        phoneLast4: t.arg({ type: "PhoneLast4", required: true }),
        newSlotToken: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
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
  }),
})
