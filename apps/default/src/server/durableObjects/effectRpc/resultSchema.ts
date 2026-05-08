import { Schema } from "effect"

/**
 * Caller-facing booking result schema, shared between the legacy RPC
 * methods on `DaySchedule` (Phase 2.1 / BI-3, kept until Phase 2.8 / B6
 * cleanup) and the new `effect/unstable/rpc` router (Phase 2.8 / BI-4).
 *
 * Why this lives here: BI-4 introduces an `RpcGroup` whose four
 * `Rpc.make(...)` definitions all share this success schema. The single
 * source of truth must be importable both by the router (effectRpc/
 * router.ts) and the DO class (DaySchedule.ts) so neither side can
 * drift independently. Phase 2.8 verification line "Phase 2.1 で
 * 構築した Schema codec が `effect/unstable/rpc` 内部でそのまま使われている
 * (二重定義なし)" is satisfied by direct re-use.
 *
 * The full `Booking` + `BookingEvent` payloads remain inside the DO's
 * storage; consumers query D1 separately for the canonical view.
 */
export const BookingResultSchema = Schema.Struct({
  bookingId: Schema.String,
  state: Schema.Literals(["Held", "Confirmed", "Cancelled", "Completed", "NoShow"]),
  eventType: Schema.Literals([
    "Held",
    "Confirmed",
    "Cancelled",
    "Rescheduled",
    "Completed",
    "NoShow",
  ]),
})
