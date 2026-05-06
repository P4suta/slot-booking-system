import { type DomainError, errorClassRegistry } from "@booking/core"
import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"
import {
  CancelBookingInputWireSchema,
  ConfirmBookingInputWireSchema,
  HoldSlotInputWireSchema,
  RescheduleBookingInputWireSchema,
} from "../inputCodec.js"
import { BookingResultSchema } from "./resultSchema.js"

/**
 * Phase 2.8 / BI-4 — typed RPC surface for `DaySchedule`.
 *
 * The four mutation entries (`HoldSlot` / `ConfirmBooking` /
 * `CancelBooking` / `RescheduleBooking`) collapse the previous
 * `Either<EncodedDomainError, EncodedResult>` ad-hoc method shape
 * (ADR-0030) into `Rpc.make(...)` definitions whose
 *   - `payload`  = the existing `*WireSchema` from `inputCodec.ts`
 *     (Phase 2.1 / BI-3 single source of wire shapes), and
 *   - `error`    = a `Schema.Union` over **every** `DomainError` class
 *     registered in `errorClassRegistry` (Phase 2.0 / BI-2 catalogue).
 *
 * No payload / error / success Schema is redefined here — every codec
 * is imported. Adding a new error class to `errorClassRegistry` makes
 * it available on every RPC's error channel for free. Adding a new
 * RPC requires only a fresh `Rpc.make(...)` plus an entry in the
 * `RpcGroup.make(...)` tuple below.
 *
 * The router travels across the Cloudflare Durable Object structured-
 * clone boundary unchanged — Phase 2.8 server (B2) and client (B3)
 * use `RpcServer.makeNoSerialization` / `RpcClient.makeNoSerialization`
 * over the native `stub.dispatch(envelope)` method, so the wire format
 * is whatever `Schema.encodeSync(...)` emits at the boundary.
 */

/**
 * Discriminated union of every `DomainError` the core emits, expressed
 * as an `Effect.Schema` that the RPC error channel decodes back into a
 * concrete TaggedError instance on the client side. The structural
 * cast through `readonly Schema.Schema.All[]` is sound at runtime —
 * each entry is a class whose `Schema.TaggedError` factory yields a
 * full `Schema.Schema.All` — but TypeScript cannot prove the variadic
 * tuple shape from a `readonly ErrorClass[]`, hence the assertion.
 */
const DomainErrorSchema = Schema.Union(
  ...(errorClassRegistry as readonly unknown[] as readonly Schema.Schema.All[]),
) as unknown as Schema.Schema<DomainError>

const HoldSlotRpc = Rpc.make("HoldSlot", {
  payload: HoldSlotInputWireSchema,
  success: BookingResultSchema,
  error: DomainErrorSchema,
})

const ConfirmBookingRpc = Rpc.make("ConfirmBooking", {
  payload: ConfirmBookingInputWireSchema,
  success: BookingResultSchema,
  error: DomainErrorSchema,
})

const CancelBookingRpc = Rpc.make("CancelBooking", {
  payload: CancelBookingInputWireSchema,
  success: BookingResultSchema,
  error: DomainErrorSchema,
})

const RescheduleBookingRpc = Rpc.make("RescheduleBooking", {
  payload: RescheduleBookingInputWireSchema,
  success: BookingResultSchema,
  error: DomainErrorSchema,
})

export const DayScheduleRouter = RpcGroup.make(
  HoldSlotRpc,
  ConfirmBookingRpc,
  CancelBookingRpc,
  RescheduleBookingRpc,
)
