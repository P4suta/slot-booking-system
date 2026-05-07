import { Schema } from "effect"
import { ServiceIdSchema } from "../../domain/types/EntityId.js"
import { PlainDateSchema } from "../../domain/types/Temporal.js"
import { FreeTextSchema } from "../../domain/value-objects/FreeText.js"
import { NameKanaSchema } from "../../domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../domain/value-objects/PhoneLast4.js"

/**
 * Inbound payload for the `HoldSlot` use case (Phase 1 entry point).
 *
 * The `Schema` is the single source of truth for:
 *   - the runtime decoder (`Schema.decodeUnknownResult`)
 *   - the static request type (`HoldSlotRequest`)
 *   - the static wire-format type (`HoldSlotRequestEncoded`)
 *   - the round-trip codec used by tests (`Schema.encodeSync` ∘ decode)
 *   - any future GraphQL / OpenAPI surface derived from the schema
 *     (Step 17, ADR-0019).
 *
 * `startMinute` is minutes from local-time midnight on `date`. Range
 * `[0, 1439]` matches the per-day cap enforced by `Minutes`.
 *
 * `freeText` is optional at the wire — `Schema.optional` decodes a
 * missing field as `Option.none()`.
 */
export const HoldSlotRequestSchema = Schema.Struct({
  serviceId: ServiceIdSchema,
  date: PlainDateSchema,
  startMinute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  freeText: Schema.optional(FreeTextSchema),
})

export type HoldSlotRequest = Schema.Schema.Type<typeof HoldSlotRequestSchema>
export type HoldSlotRequestEncoded = Schema.Codec.Encoded<typeof HoldSlotRequestSchema>
