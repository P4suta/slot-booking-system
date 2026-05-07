import {
  type AvailableSlot,
  BookingCodeFromUserInputSchema,
  BookingSourceSchema,
  type BusinessTimeZone,
  type CancelBookingInput,
  type ConfirmBookingInput,
  FreeTextSchema,
  type HoldSlotInput,
  InvalidTimeSlotError,
  mintAvailableSlot,
  NameKanaSchema,
  PhoneLast4Schema,
  ProviderIdSchema,
  type RescheduleBookingInput,
  ResourceIdSchema,
  ServiceIdSchema,
  StorageError,
  summarizeParse,
} from "@booking/core"
import { Temporal } from "@js-temporal/polyfill"
import { Effect, Schema } from "effect"

/**
 * Schema codecs at the DO RPC boundary (Phase 2.1 / BI-3). Each Worker
 * → Durable-Object call passes through Cloudflare's structured-clone
 * envelope, which preserves only JSON-shaped values; branded
 * `Temporal.Instant` / `ZonedDateTime` instances do not survive. The
 * resolver therefore speaks the encoded (string-only) form, the DO
 * speaks the encoded form on input, and these codecs reconstruct the
 * domain values inside the DO before the use case runs.
 *
 * Why a static wire schema rather than a parametric (timezone-aware)
 * codec: the `Schema.Codec.Encoded<...>` extracted on the resolver
 * side has to be a constant, RPC-method-shape type. ZDT reconstruction
 * needs a per-deployment `BusinessTimeZone`, so the timezone is taken
 * separately and applied in {@link reconstructSlot} after Schema-level
 * shape validation. The result is the smallest surface that gets the
 * casts (`as unknown as Parameters<DaySchedule[…]>[0]`) out of the
 * resolver while keeping the Schema as the single source of truth for
 * the wire format.
 */

const AvailableSlotInputWireSchema = Schema.Struct({
  serviceId: ServiceIdSchema,
  /** ISO-8601 instant — `2026-05-06T10:00:00Z`. */
  start: Schema.String,
  end: Schema.String,
  providerId: ProviderIdSchema,
  resourceIds: Schema.Array(ResourceIdSchema),
})
type AvailableSlotInputDecoded = Schema.Schema.Type<typeof AvailableSlotInputWireSchema>

export const HoldSlotInputWireSchema = Schema.Struct({
  slot: AvailableSlotInputWireSchema,
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  freeText: Schema.NullOr(FreeTextSchema),
  source: BookingSourceSchema,
})

export const ConfirmBookingInputWireSchema = Schema.Struct({
  code: BookingCodeFromUserInputSchema,
  phoneLast4: PhoneLast4Schema,
})

export const CancelBookingInputWireSchema = Schema.Struct({
  code: BookingCodeFromUserInputSchema,
  phoneLast4: PhoneLast4Schema,
  reason: Schema.String,
})

export const RescheduleBookingInputWireSchema = Schema.Struct({
  code: BookingCodeFromUserInputSchema,
  phoneLast4: PhoneLast4Schema,
  newSlot: AvailableSlotInputWireSchema,
})

/**
 * Reconstruct an {@link AvailableSlot} from its wire shape and the
 * deployment timezone. The HMAC-signature check in the resolver
 * `verifyOrRefuse` already guarantees the wire fields were minted by
 * a previous `availableSlots` call — this function just relifts them
 * back through `mintAvailableSlot`'s brand. Failures here originate
 * from a malformed `Temporal.Instant.from(...)` (the only call that
 * can throw given the wire form has already been Schema-validated).
 */
const reconstructSlot = (tz: BusinessTimeZone, wire: AvailableSlotInputDecoded): AvailableSlot =>
  mintAvailableSlot({
    serviceId: wire.serviceId,
    start: Temporal.Instant.from(wire.start).toZonedDateTimeISO(tz),
    end: Temporal.Instant.from(wire.end).toZonedDateTimeISO(tz),
    providerId: wire.providerId,
    resourceIds: wire.resourceIds,
  })

const decodeWire = <A, I>(
  label: string,
  schema: Schema.Codec<A, I>,
  wire: unknown,
): Effect.Effect<A, StorageError> => {
  const decode: (input: unknown) => A = Schema.decodeUnknownSync(schema)
  return Effect.try({
    try: () => decode(wire),
    catch: (e) =>
      new StorageError({
        reason: `${label} input decode: ${e instanceof Error ? summarizeParse(e as never) : "unknown"}`,
        cause: e,
      }),
  })
}

const wrapSlotReconstruction = (
  tz: BusinessTimeZone,
  wire: AvailableSlotInputDecoded,
): Effect.Effect<AvailableSlot, InvalidTimeSlotError> =>
  Effect.try({
    try: () => reconstructSlot(tz, wire),
    catch: (e) =>
      new InvalidTimeSlotError({
        reason: `slot instant parse failed: ${e instanceof Error ? e.message : "unknown"}`,
      }),
  })

/**
 * Wire → domain decoder for the `holdSlot` RPC. Surfaces shape
 * failures as `StorageError` (internal contract — the resolver
 * controls the wire form) and instant-parse failures as
 * `InvalidTimeSlotError`.
 */
export const decodeHoldSlotInput = (
  tz: BusinessTimeZone,
  wire: unknown,
): Effect.Effect<HoldSlotInput, StorageError | InvalidTimeSlotError> =>
  Effect.gen(function* () {
    const w = yield* decodeWire("holdSlot", HoldSlotInputWireSchema, wire)
    const slot = yield* wrapSlotReconstruction(tz, w.slot)
    return {
      slot,
      nameKana: w.nameKana,
      phoneLast4: w.phoneLast4,
      freeText: w.freeText,
      source: w.source,
    } satisfies HoldSlotInput
  })

export const decodeConfirmBookingInput = (
  wire: unknown,
): Effect.Effect<ConfirmBookingInput, StorageError> =>
  Effect.gen(function* () {
    const w = yield* decodeWire("confirmBooking", ConfirmBookingInputWireSchema, wire)
    return {
      code: w.code,
      phoneLast4: w.phoneLast4,
    } satisfies ConfirmBookingInput
  })

export const decodeCancelBookingInput = (
  wire: unknown,
): Effect.Effect<CancelBookingInput, StorageError> =>
  Effect.gen(function* () {
    const w = yield* decodeWire("cancelBooking", CancelBookingInputWireSchema, wire)
    return {
      code: w.code,
      phoneLast4: w.phoneLast4,
      reason: w.reason,
    } satisfies CancelBookingInput
  })

export const decodeRescheduleBookingInput = (
  tz: BusinessTimeZone,
  wire: unknown,
): Effect.Effect<RescheduleBookingInput, StorageError | InvalidTimeSlotError> =>
  Effect.gen(function* () {
    const w = yield* decodeWire("rescheduleBooking", RescheduleBookingInputWireSchema, wire)
    const newSlot = yield* wrapSlotReconstruction(tz, w.newSlot)
    return {
      code: w.code,
      phoneLast4: w.phoneLast4,
      newSlot,
    } satisfies RescheduleBookingInput
  })
