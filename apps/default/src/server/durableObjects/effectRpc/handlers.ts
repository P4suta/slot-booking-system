import {
  type BookingEventSourcedRepository,
  type BusinessTimeZone,
  CancelBooking,
  type Clock,
  ConfirmBooking,
  HoldSlot,
  type IdGenerator,
  type Logger,
  RescheduleBooking,
} from "@booking/core"
import { Effect, type Layer } from "effect"
import {
  decodeCancelBookingInput,
  decodeConfirmBookingInput,
  decodeHoldSlotInput,
  decodeRescheduleBookingInput,
} from "../inputCodec.js"
import { DayScheduleRouter } from "./router.js"

/**
 * Use-case-level dependencies the four `DaySchedule` handlers need at
 * runtime. The DO assembles this layer per request from its own
 * `ctx.storage` reference (event-sourced repo + clock + id generator +
 * logger). The handlers below stay agnostic of *how* those services
 * are produced — they just consume them through `Effect.provide(layer)`.
 */
type DayScheduleRuntime = BookingEventSourcedRepository | Clock | IdGenerator | Logger

/**
 * Handlers Layer for {@link DayScheduleRouter}. Each handler:
 *   1. decodes the wire payload via the per-RPC `decode*Input` helpers
 *      (Phase 2.1 / BI-3 — preserved verbatim),
 *   2. runs the corresponding use case from `@booking/core`, and
 *   3. projects the (`booking`, `event`) result tuple to the caller-
 *      facing {@link BookingResultSchema} shape.
 *
 * Errors flow through the RPC error channel as concrete `DomainError`
 * tagged-error instances — `effect/unstable/rpc` round-trips them via the
 * `Schema.Union(...errorClassRegistry)` defined on each `Rpc.make`.
 *
 * `tz` is captured as a value rather than resolved inside each handler
 * — the DO's `dispatch()` entry resolves the deployment timezone once
 * per request and closes over it here. This avoids re-walking the
 * Effect that owns the `BusinessTimeZone` parse for every handler call.
 */
export const DayScheduleHandlersLayer = (
  tz: BusinessTimeZone,
  runtime: Layer.Layer<DayScheduleRuntime>,
) =>
  DayScheduleRouter.toLayer({
    HoldSlot: (payload) =>
      Effect.gen(function* () {
        const decoded = yield* decodeHoldSlotInput(tz, payload)
        const r = yield* HoldSlot(decoded)
        return {
          bookingId: r.booking.id,
          state: r.booking.state,
          eventType: r.event.type,
        }
      }).pipe(Effect.provide(runtime)),

    ConfirmBooking: (payload) =>
      Effect.gen(function* () {
        const decoded = yield* decodeConfirmBookingInput(payload)
        const r = yield* ConfirmBooking(decoded)
        return {
          bookingId: r.booking.id,
          state: r.booking.state,
          eventType: r.event.type,
        }
      }).pipe(Effect.provide(runtime)),

    CancelBooking: (payload) =>
      Effect.gen(function* () {
        const decoded = yield* decodeCancelBookingInput(payload)
        const r = yield* CancelBooking(decoded)
        return {
          bookingId: r.booking.id,
          state: r.booking.state,
          eventType: r.event.type,
        }
      }).pipe(Effect.provide(runtime)),

    RescheduleBooking: (payload) =>
      Effect.gen(function* () {
        const decoded = yield* decodeRescheduleBookingInput(tz, payload)
        const r = yield* RescheduleBooking(decoded)
        return {
          bookingId: r.booking.id,
          state: r.booking.state,
          eventType: r.event.type,
        }
      }).pipe(Effect.provide(runtime)),
  })
