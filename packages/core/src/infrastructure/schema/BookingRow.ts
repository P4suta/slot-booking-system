import { Schema, SchemaGetter } from "effect"
import { ActorSchema, type Booking, BookingSourceSchema } from "../../domain/booking/Booking.js"
import {
  BookingIdSchema,
  ProviderIdSchema,
  ResourceIdSchema,
  ServiceIdSchema,
} from "../../domain/types/EntityId.js"
import { InstantSelf } from "../../domain/types/Temporal.js"
import { BookingCodeFromUserInputSchema } from "../../domain/value-objects/BookingCode.js"
import { FreeTextSchema } from "../../domain/value-objects/FreeText.js"
import { NameKanaSchema } from "../../domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../domain/value-objects/PhoneLast4.js"

/**
 * Per-variant flat-row schemas — Type-level only. The (DU ↔ flat row)
 * codec at the bottom of this file is built as a `Schema.Union` over
 * five `Schema.decodeTo` overlays — one per variant, each carrying the
 * trivial isomorphism `slot ↔ (slotStart, slotEnd)`. The structure is
 * a **discriminated coproduct decoder** (one fiber per state literal),
 * with the variant tag acting as the discriminator both directions.
 *
 * Both source (row) and target (variant) use `InstantSelf` for time
 * fields rather than `InstantSchema`'s `Instant ↔ string` codec — the
 * row codec stays at the Type level, leaving wire encoding (D1 column
 * binding, JSON envelope) as a separate concern at the SQL boundary.
 * This keeps the slot transformation a pure 1:1 isomorphism — no
 * Instant ↔ ISO-string detour, no nullable timestamp branching.
 * ADR-0032.
 */

const CommonRowFields = {
  id: BookingIdSchema,
  code: BookingCodeFromUserInputSchema,
  serviceId: ServiceIdSchema,
  providerId: ProviderIdSchema,
  resourceIds: Schema.Array(ResourceIdSchema),
  slotStart: InstantSelf,
  slotEnd: InstantSelf,
  source: BookingSourceSchema,
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  freeText: Schema.NullOr(FreeTextSchema),
} as const

export const HeldRowSchema = Schema.Struct({
  ...CommonRowFields,
  state: Schema.Literal("Held"),
  heldAt: InstantSelf,
  expiresAt: InstantSelf,
})

export const ConfirmedRowSchema = Schema.Struct({
  ...CommonRowFields,
  state: Schema.Literal("Confirmed"),
  confirmedAt: InstantSelf,
})

export const CancelledRowSchema = Schema.Struct({
  ...CommonRowFields,
  state: Schema.Literal("Cancelled"),
  cancelledAt: InstantSelf,
  cancelledBy: ActorSchema,
  cancelReason: Schema.String,
})

export const CompletedRowSchema = Schema.Struct({
  ...CommonRowFields,
  state: Schema.Literal("Completed"),
  completedAt: InstantSelf,
})

export const NoShowRowSchema = Schema.Struct({
  ...CommonRowFields,
  state: Schema.Literal("NoShow"),
  markedAt: InstantSelf,
  markedBy: ActorSchema,
})

/**
 * Variant-tagged flat-row union. The canonical wire shape between SQL
 * persistence and the domain — one arm per Booking variant, each
 * carrying only the timestamps that belong to it.
 */
export const BookingRowSchema = Schema.Union([
  HeldRowSchema,
  ConfirmedRowSchema,
  CancelledRowSchema,
  CompletedRowSchema,
  NoShowRowSchema,
])
export type BookingRow = Schema.Schema.Type<typeof BookingRowSchema>

/* -------------------------------------------------------------------------- */
/* Type-only domain variants (mirror Booking.ts but on `InstantSelf`).        */
/* The codec below stays at the Type level so the slot transform is a pure   */
/* 1:1 isomorphism — Instant ↔ string conversion happens at the wire         */
/* boundary, not inside the row codec.                                        */
/* -------------------------------------------------------------------------- */

const CommonDomainFields = {
  id: BookingIdSchema,
  code: BookingCodeFromUserInputSchema,
  serviceId: ServiceIdSchema,
  providerId: ProviderIdSchema,
  resourceIds: Schema.Array(ResourceIdSchema),
  slot: Schema.Struct({ start: InstantSelf, end: InstantSelf }),
  source: BookingSourceSchema,
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  freeText: Schema.NullOr(FreeTextSchema),
} as const

const HeldDomain = Schema.Struct({
  ...CommonDomainFields,
  state: Schema.Literal("Held"),
  heldAt: InstantSelf,
  expiresAt: InstantSelf,
})

const ConfirmedDomain = Schema.Struct({
  ...CommonDomainFields,
  state: Schema.Literal("Confirmed"),
  confirmedAt: InstantSelf,
})

const CancelledDomain = Schema.Struct({
  ...CommonDomainFields,
  state: Schema.Literal("Cancelled"),
  cancelledAt: InstantSelf,
  reason: Schema.String,
  cancelledBy: ActorSchema,
})

const CompletedDomain = Schema.Struct({
  ...CommonDomainFields,
  state: Schema.Literal("Completed"),
  completedAt: InstantSelf,
})

const NoShowDomain = Schema.Struct({
  ...CommonDomainFields,
  state: Schema.Literal("NoShow"),
  markedAt: InstantSelf,
  markedBy: ActorSchema,
})

const liftSlot = (
  rest: Readonly<Record<string, unknown>> & {
    readonly slotStart: unknown
    readonly slotEnd: unknown
  },
) => {
  const { slotStart, slotEnd, ...others } = rest
  return { ...others, slot: { start: slotStart, end: slotEnd } } as never
}

const flattenSlot = (
  rest: Readonly<Record<string, unknown>> & {
    readonly slot: { readonly start: unknown; readonly end: unknown }
  },
) => {
  const { slot, ...others } = rest
  return { ...others, slotStart: slot.start, slotEnd: slot.end } as never
}

const HeldFromRow = HeldRowSchema.pipe(
  Schema.decodeTo(HeldDomain, {
    decode: SchemaGetter.transform(liftSlot),
    encode: SchemaGetter.transform(flattenSlot),
  }),
)

const ConfirmedFromRow = ConfirmedRowSchema.pipe(
  Schema.decodeTo(ConfirmedDomain, {
    decode: SchemaGetter.transform(liftSlot),
    encode: SchemaGetter.transform(flattenSlot),
  }),
)

const CancelledFromRow = CancelledRowSchema.pipe(
  Schema.decodeTo(CancelledDomain, {
    decode: SchemaGetter.transform(
      ({ slotStart, slotEnd, cancelReason, ...rest }) =>
        ({
          ...rest,
          slot: { start: slotStart, end: slotEnd },
          reason: cancelReason,
        }) as never,
    ),
    encode: SchemaGetter.transform(
      ({ slot, reason, ...rest }) =>
        ({
          ...rest,
          slotStart: slot.start,
          slotEnd: slot.end,
          cancelReason: reason,
        }) as never,
    ),
  }),
)

const CompletedFromRow = CompletedRowSchema.pipe(
  Schema.decodeTo(CompletedDomain, {
    decode: SchemaGetter.transform(liftSlot),
    encode: SchemaGetter.transform(flattenSlot),
  }),
)

const NoShowFromRow = NoShowRowSchema.pipe(
  Schema.decodeTo(NoShowDomain, {
    decode: SchemaGetter.transform(liftSlot),
    encode: SchemaGetter.transform(flattenSlot),
  }),
)

/**
 * `Booking` ↔ `BookingRow` codec. The `Schema.Union` of five per-variant
 * `decodeTo` overlays — exhaustive at compile time, total at runtime,
 * with no hand-written `switch (state)` block. The state literal in
 * each arm acts as the discriminator both directions.
 *
 * The cast is sound: each arm's Type structurally mirrors the
 * corresponding `BookingT<S>` from `domain/booking/Booking.ts` (same
 * fields, same `InstantSelf` Instant carrier), so the union of arms
 * matches `Booking` at the Type level. The `as` is the boundary that
 * records this contract — the codec is internally constructed against
 * Type-only `*Domain` variants to dodge the `Instant ↔ string` round-
 * trip that would otherwise be threaded through `decodeTo`'s
 * `From.Type → To.Encoded` transform direction.
 */
export const BookingFromRow = Schema.Union([
  HeldFromRow,
  ConfirmedFromRow,
  CancelledFromRow,
  CompletedFromRow,
  NoShowFromRow,
]) as unknown as Schema.Codec<Booking, BookingRow>
