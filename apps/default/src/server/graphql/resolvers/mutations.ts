import { Either } from "effect"
import { GraphQLError } from "graphql"
import type { DaySchedule } from "../../durableObjects/DaySchedule.js"
import { domainErrorTagToStatus } from "../../durableObjects/DaySchedule.js"
import { builder, type GraphQLContext } from "../builder.js"

/**
 * Booking mutations — `holdSlot`, `confirmBooking`, `cancelBooking`,
 * `rescheduleBooking`. Each resolver delegates to the per-day
 * `DaySchedule` Durable Object via direct RPC method invocation
 * (ADR-0030 / 2026 mainstream). Writes serialise inside the actor
 * model; the DO returns `Either<EncodedDomainError, EncodedResult>`,
 * the resolver narrows on `_tag` and either returns the encoded
 * success or throws a typed `GraphQLError`.
 *
 * Throwing the domain error directly across the RPC boundary would
 * lose its discriminated-union shape (Cloudflare strips custom Error
 * subclass fields); the explicit `Either` channel preserves it.
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

/** Unwrap an `Either<EncResult, EncDomainError>` from the DO into a GraphQL response. */
const unwrap = <R extends BookingResultShape>(
  result: Either.Either<R, { readonly _tag: string; readonly code: string }>,
): R => {
  if (Either.isRight(result)) return result.right
  const err = result.left
  throw new GraphQLError(`${err._tag} (${err.code})`, {
    extensions: {
      code: err.code,
      tag: err._tag,
      status: domainErrorTagToStatus(err._tag),
    },
  })
}

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
      resolve: async (_root, args, ctx) => {
        const stub = dayDoFor(ctx.env, args.date)
        const result = await Promise.resolve(
          stub.holdSlot({
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
          } as unknown as Parameters<DaySchedule["holdSlot"]>[0]),
        )
        return unwrap(result)
      },
    }),

    confirmBooking: t.field({
      type: BookingResultType,
      description: "Promote a Held booking to Confirmed via code + phoneLast4.",
      args: {
        date: t.arg({ type: "PlainDate", required: true }),
        code: t.arg.string({ required: true }),
        phoneLast4: t.arg({ type: "PhoneLast4", required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const stub = dayDoFor(ctx.env, args.date)
        const result = await Promise.resolve(
          stub.confirmBooking({
            code: args.code,
            phoneLast4: args.phoneLast4,
          } as unknown as Parameters<DaySchedule["confirmBooking"]>[0]),
        )
        return unwrap(result)
      },
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
      resolve: async (_root, args, ctx) => {
        const stub = dayDoFor(ctx.env, args.date)
        const result = await Promise.resolve(
          stub.cancelBooking({
            code: args.code,
            phoneLast4: args.phoneLast4,
            reason: args.reason,
          } as unknown as Parameters<DaySchedule["cancelBooking"]>[0]),
        )
        return unwrap(result)
      },
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
      resolve: async (_root, args, ctx) => {
        const stub = dayDoFor(ctx.env, args.date)
        const result = await Promise.resolve(
          stub.rescheduleBooking({
            code: args.code,
            phoneLast4: args.phoneLast4,
            newSlot: {
              serviceId: args.serviceId,
              providerId: args.providerId,
              resourceIds: args.resourceIds,
              start: args.slotStart,
              end: args.slotEnd,
            },
          } as unknown as Parameters<DaySchedule["rescheduleBooking"]>[0]),
        )
        return unwrap(result)
      },
    }),
  }),
})
