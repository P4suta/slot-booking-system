import { GraphQLError } from "graphql"
import { builder } from "../builder.js"

/**
 * Booking mutations — `holdSlot`, `confirmBooking`, `cancelBooking`,
 * `rescheduleBooking`. Each resolver delegates to the per-day
 * `DaySchedule` Durable Object so writes serialise inside the actor;
 * the DO runs the corresponding use case under its own per-request
 * Effect runtime and returns a JSON envelope (`{ ok, result | error }`)
 * that the resolver re-shapes into a GraphQL response.
 *
 * The DO id is derived from the booking's date so two requests for the
 * same day always land on the same actor; cross-day independence is
 * preserved automatically.
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

type DOEnvelope = {
  readonly ok: boolean
  readonly result?: {
    readonly booking?: { readonly id?: string; readonly state?: string }
    readonly event?: { readonly type?: string }
  }
  readonly error?: { readonly _tag?: string; readonly code?: string }
}

const dayDoFor = (env: GraphQLContext["env"], date: string): DurableObjectStub => {
  const id = env.DAY_SCHEDULE.idFromName(date)
  return env.DAY_SCHEDULE.get(id)
}

const callDO = async (
  ctx: GraphQLContext,
  date: string,
  body: Readonly<Record<string, unknown>>,
): Promise<{ bookingId: string; state: string; eventType: string }> => {
  const stub = dayDoFor(ctx.env, date)
  const res = await stub.fetch("https://do.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const envelope: DOEnvelope = await res.json()
  if (!envelope.ok || envelope.result === undefined) {
    const tag = envelope.error?._tag ?? "InternalError"
    const code = envelope.error?.code ?? "E_INTERNAL"
    throw new GraphQLError(`${tag} (${code})`, {
      extensions: { code, status: res.status, tag },
    })
  }
  const booking = envelope.result.booking
  const event = envelope.result.event
  return {
    bookingId: booking?.id ?? "",
    state: booking?.state ?? "",
    eventType: event?.type ?? "",
  }
}

import type { GraphQLContext } from "../builder.js"

builder.mutationType({
  fields: (t) => ({
    holdSlot: t.field({
      type: BookingResultType,
      description: "Place a 5-minute hold on the supplied AvailableSlot.",
      args: {
        date: t.arg({ type: "PlainDate", required: true }),
        serviceId: t.arg.string({ required: true }),
        providerId: t.arg.string({ required: true }),
        resourceIds: t.arg.stringList({ required: true }),
        slotStart: t.arg({ type: "Instant", required: true }),
        slotEnd: t.arg({ type: "Instant", required: true }),
        nameKana: t.arg.string({ required: true }),
        phoneLast4: t.arg({ type: "PhoneLast4", required: true }),
        freeText: t.arg.string({ required: false }),
        source: t.arg.string({ required: true }),
      },
      resolve: (_root, args, ctx) =>
        callDO(ctx, args.date, {
          type: "hold",
          payload: {
            slot: {
              serviceId: args.serviceId,
              providerId: args.providerId,
              resourceIds: args.resourceIds,
              start: args.slotStart,
              end: args.slotEnd,
            },
            nameKana: args.nameKana,
            phoneLast4: args.phoneLast4,
            freeText: args.freeText ?? null,
            source: args.source,
          },
        }),
    }),

    confirmBooking: t.field({
      type: BookingResultType,
      description: "Promote a Held booking to Confirmed via code + phoneLast4.",
      args: {
        date: t.arg({ type: "PlainDate", required: true }),
        code: t.arg.string({ required: true }),
        phoneLast4: t.arg({ type: "PhoneLast4", required: true }),
      },
      resolve: (_root, args, ctx) =>
        callDO(ctx, args.date, {
          type: "confirm",
          payload: { code: args.code, phoneLast4: args.phoneLast4 },
        }),
    }),

    cancelBooking: t.field({
      type: BookingResultType,
      description: "Cancel a Held or Confirmed booking via code + phoneLast4.",
      args: {
        date: t.arg({ type: "PlainDate", required: true }),
        code: t.arg.string({ required: true }),
        phoneLast4: t.arg({ type: "PhoneLast4", required: true }),
        reason: t.arg.string({ required: true }),
      },
      resolve: (_root, args, ctx) =>
        callDO(ctx, args.date, {
          type: "cancel",
          payload: {
            code: args.code,
            phoneLast4: args.phoneLast4,
            reason: args.reason,
          },
        }),
    }),

    rescheduleBooking: t.field({
      type: BookingResultType,
      description: "Move a Confirmed booking to a different AvailableSlot on the same day.",
      args: {
        date: t.arg({ type: "PlainDate", required: true }),
        code: t.arg.string({ required: true }),
        phoneLast4: t.arg({ type: "PhoneLast4", required: true }),
        serviceId: t.arg.string({ required: true }),
        providerId: t.arg.string({ required: true }),
        resourceIds: t.arg.stringList({ required: true }),
        slotStart: t.arg({ type: "Instant", required: true }),
        slotEnd: t.arg({ type: "Instant", required: true }),
      },
      resolve: (_root, args, ctx) =>
        callDO(ctx, args.date, {
          type: "reschedule",
          payload: {
            code: args.code,
            phoneLast4: args.phoneLast4,
            newSlot: {
              serviceId: args.serviceId,
              providerId: args.providerId,
              resourceIds: args.resourceIds,
              start: args.slotStart,
              end: args.slotEnd,
            },
          },
        }),
    }),
  }),
})
