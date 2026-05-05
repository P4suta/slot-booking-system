import { Schema } from "effect"
import {
  ActorSchema,
  BookingSourceSchema,
  CancelledSchema,
  CompletedSchema,
  ConfirmedSchema,
  HeldSchema,
  NoShowSchema,
} from "../../domain/booking/Booking.js"
import {
  BookingIdSchema,
  ProviderIdSchema,
  ResourceIdSchema,
  ServiceIdSchema,
} from "../../domain/types/EntityId.js"
import { InstantSchema } from "../../domain/types/Temporal.js"
import { BookingCodeFromUserInputSchema } from "../../domain/value-objects/BookingCode.js"
import { FreeTextSchema } from "../../domain/value-objects/FreeText.js"
import { NameKanaSchema } from "../../domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../domain/value-objects/PhoneLast4.js"

/**
 * Per-variant flat-row schemas. Each shares the booking aggregate's
 * common fields (with `slot: TimeSlot` flattened to two `Instant` columns
 * `slotStart` / `slotEnd`) plus exactly the timestamp columns its variant
 * owns.
 *
 * The (DU ↔ flat row) codec at the bottom of this file is built as a
 * `Schema.Union` over five `Schema.transform`s — one per variant. Each
 * arm carries the trivial isomorphism `slot ↔ (slotStart, slotEnd)`,
 * leaving the rest of the fields aligned by name. Replaces the 124-line
 * hand-rolled per-state switch in `D1BookingRepositoryLive` (deleted)
 * with a declarative, schema-driven mapping (ADR-0032).
 */

const CommonRowFields = {
  id: BookingIdSchema,
  code: BookingCodeFromUserInputSchema,
  serviceId: ServiceIdSchema,
  providerId: ProviderIdSchema,
  resourceIds: Schema.Array(ResourceIdSchema),
  slotStart: InstantSchema,
  slotEnd: InstantSchema,
  source: BookingSourceSchema,
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  freeText: Schema.NullOr(FreeTextSchema),
} as const

export const HeldRowSchema = Schema.Struct({
  ...CommonRowFields,
  state: Schema.Literal("Held"),
  heldAt: InstantSchema,
  expiresAt: InstantSchema,
})

export const ConfirmedRowSchema = Schema.Struct({
  ...CommonRowFields,
  state: Schema.Literal("Confirmed"),
  confirmedAt: InstantSchema,
})

export const CancelledRowSchema = Schema.Struct({
  ...CommonRowFields,
  state: Schema.Literal("Cancelled"),
  cancelledAt: InstantSchema,
  cancelledBy: ActorSchema,
  cancelReason: Schema.String,
})

export const CompletedRowSchema = Schema.Struct({
  ...CommonRowFields,
  state: Schema.Literal("Completed"),
  completedAt: InstantSchema,
})

export const NoShowRowSchema = Schema.Struct({
  ...CommonRowFields,
  state: Schema.Literal("NoShow"),
  markedAt: InstantSchema,
  markedBy: ActorSchema,
})

/**
 * Variant-tagged flat-row union. The canonical wire shape between SQL
 * persistence and the domain — one arm per Booking variant, each
 * carrying only the timestamps that belong to it.
 */
export const BookingRowSchema = Schema.Union(
  HeldRowSchema,
  ConfirmedRowSchema,
  CancelledRowSchema,
  CompletedRowSchema,
  NoShowRowSchema,
)
export type BookingRow = Schema.Schema.Type<typeof BookingRowSchema>

/* -------------------------------------------------------------------------- */
/* Per-variant codec — `slot ↔ (slotStart, slotEnd)` is the only structural   */
/* difference between row and domain forms inside each arm. The transform     */
/* lives at the Type level (`Schema.typeSchema(...)`), so the inner pair is   */
/* a pure 1:1 isomorphism — no Instant ↔ ISO-string detour, no nullable       */
/* timestamp branching. The variant tag and the per-variant subset of         */
/* timestamps make the routing structurally exhaustive.                       */
/* -------------------------------------------------------------------------- */

const HeldFromRow = Schema.transform(
  Schema.typeSchema(HeldRowSchema),
  Schema.typeSchema(HeldSchema),
  {
    strict: true,
    decode: ({ slotStart, slotEnd, ...rest }) => ({
      ...rest,
      slot: { start: slotStart, end: slotEnd },
    }),
    encode: ({ slot, ...rest }) => ({ ...rest, slotStart: slot.start, slotEnd: slot.end }),
  },
)

const ConfirmedFromRow = Schema.transform(
  Schema.typeSchema(ConfirmedRowSchema),
  Schema.typeSchema(ConfirmedSchema),
  {
    strict: true,
    decode: ({ slotStart, slotEnd, ...rest }) => ({
      ...rest,
      slot: { start: slotStart, end: slotEnd },
    }),
    encode: ({ slot, ...rest }) => ({ ...rest, slotStart: slot.start, slotEnd: slot.end }),
  },
)

const CancelledFromRow = Schema.transform(
  Schema.typeSchema(CancelledRowSchema),
  Schema.typeSchema(CancelledSchema),
  {
    strict: true,
    decode: ({ slotStart, slotEnd, cancelReason, ...rest }) => ({
      ...rest,
      slot: { start: slotStart, end: slotEnd },
      reason: cancelReason,
    }),
    encode: ({ slot, reason, ...rest }) => ({
      ...rest,
      slotStart: slot.start,
      slotEnd: slot.end,
      cancelReason: reason,
    }),
  },
)

const CompletedFromRow = Schema.transform(
  Schema.typeSchema(CompletedRowSchema),
  Schema.typeSchema(CompletedSchema),
  {
    strict: true,
    decode: ({ slotStart, slotEnd, ...rest }) => ({
      ...rest,
      slot: { start: slotStart, end: slotEnd },
    }),
    encode: ({ slot, ...rest }) => ({ ...rest, slotStart: slot.start, slotEnd: slot.end }),
  },
)

const NoShowFromRow = Schema.transform(
  Schema.typeSchema(NoShowRowSchema),
  Schema.typeSchema(NoShowSchema),
  {
    strict: true,
    decode: ({ slotStart, slotEnd, ...rest }) => ({
      ...rest,
      slot: { start: slotStart, end: slotEnd },
    }),
    encode: ({ slot, ...rest }) => ({ ...rest, slotStart: slot.start, slotEnd: slot.end }),
  },
)

/**
 * `Booking` ↔ `BookingRow` codec. The `Schema.Union` of five per-variant
 * transforms — exhaustive at compile time, total at runtime, with no
 * hand-written `switch (state)` block. The state literal in each arm
 * acts as the discriminator both directions.
 *
 * Type witness: `Schema.Schema.Type<typeof BookingFromRow>` is exactly
 * `Booking`, and `Schema.Schema.Encoded<typeof BookingFromRow>` matches
 * the wire shape `BookingRowSchema` produces.
 */
export const BookingFromRow = Schema.Union(
  HeldFromRow,
  ConfirmedFromRow,
  CancelledFromRow,
  CompletedFromRow,
  NoShowFromRow,
)
