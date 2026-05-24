import { Schema } from "effect"

/**
 * HTTP response-side wire schemas (ADR-0085). The customer / staff
 * client observes these shapes after JSON serialisation of the
 * domain `Ticket` union + projection entries.
 *
 * The domain `TicketSchema` (`packages/core/src/domain/queue/
 * Ticket.ts`) is a discriminated union of six state variants.
 * OpenAPI 3.1 with `oneOf` would force the web client codegen to
 * emit a TS discriminated union for every consumer to narrow at
 * each use site; ADR-0083 / `apps/web/src/lib/api.ts` would accrue
 * narrowing rituals. We deliberately flatten the union to one
 * permissive object: every common field is `required`, every
 * state-specific field is `optional`, the `state` enum picks the
 * actual variant at runtime.
 *
 * The fields are declared with plain `Schema.String` for ISO-8601
 * instants (rather than `InstantSchema`) to dodge a
 * `Schema.toJsonSchemaDocument` quirk: a schema that references
 * `InstantSchema` more than once causes any other inline
 * `{ type: "string" }` field to be rewritten as
 * `{ $ref: "#/$defs/Instant" }` (structural dedup runs without
 * checking semantic identity). Instants stay as `string` here —
 * the domain layer is the authority on their runtime parse — and
 * a property test pins that every legal `Ticket` round-trips
 * through `WireTicketSchema` so drift between domain ↔ wire is
 * statically detected.
 */

const TicketIdPatternSchema = Schema.String.check(Schema.isPattern(/^tkt_[A-Za-z0-9]{8,}$/))
const PhoneLast4PatternSchema = Schema.String.check(Schema.isPattern(/^[0-9]{4}$/))

const Iso8601Schema = Schema.String

const LaneEnumSchema = Schema.Literals(["walkIn", "reservation"])
const ActorEnumSchema = Schema.Literals(["customer", "staff", "system"])
const TicketStateEnumSchema = Schema.Literals([
  "Waiting",
  "Called",
  "Overdue",
  "Served",
  "NoShow",
  "Cancelled",
])

/**
 * Flat-collapsed wire image of `Ticket`. Required keys mirror
 * `CommonFields` + `state`; everything else is optional and only
 * shows up on the variants that own it (e.g. `cancelledAt` /
 * `cancelledBy` / `reason` only appear on `state === "Cancelled"`).
 * `nudgeCount` (Overdue only) is hoisted as optional in the shared
 * shape — pragmatic over-permission rather than a separate
 * `OverdueProjectionEntry` component (ADR-0072).
 */
export const WireTicketSchema = Schema.Struct({
  id: TicketIdPatternSchema,
  seq: Schema.Int,
  lane: LaneEnumSchema,
  displaySeq: Schema.Int,
  nameKana: Schema.String,
  phoneLast4: PhoneLast4PatternSchema,
  freeText: Schema.NullOr(Schema.String),
  issuedAt: Iso8601Schema,
  appointmentAt: Schema.NullOr(Iso8601Schema),
  checkedInAt: Schema.NullOr(Iso8601Schema),
  state: TicketStateEnumSchema,
  calledAt: Schema.optional(Iso8601Schema),
  calledBy: Schema.optional(ActorEnumSchema),
  overdueAt: Schema.optional(Iso8601Schema),
  lastNudgedAt: Schema.optional(Schema.NullOr(Iso8601Schema)),
  nudgeCount: Schema.optional(Schema.Int),
  servedAt: Schema.optional(Iso8601Schema),
  servedBy: Schema.optional(ActorEnumSchema),
  markedAt: Schema.optional(Iso8601Schema),
  markedBy: Schema.optional(ActorEnumSchema),
  cancelledAt: Schema.optional(Iso8601Schema),
  cancelledBy: Schema.optional(ActorEnumSchema),
  reason: Schema.optional(Schema.String),
})

/**
 * Anonymous projection entry (ADR-0084) — the PII-free image the
 * customer-side `/queue` poll consumes. `nudgeCount` is present
 * only on the Overdue array (ADR-0072).
 */
export const WireProjectionEntrySchema = Schema.Struct({
  id: TicketIdPatternSchema,
  seq: Schema.Int,
  lane: LaneEnumSchema,
  displaySeq: Schema.Int,
  appointmentAt: Schema.NullOr(Iso8601Schema),
  nudgeCount: Schema.optional(Schema.Int),
})

/** `{ ok: true, ticket }` — the standard write-side success body. */
export const WireTicketEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  ticket: WireTicketSchema,
})

/**
 * ADR-0069 §idempotent merge — `IssueTicket` returns 200 with
 * `merged: true` on a duplicate-handle re-issue. Same shape as
 * `WireTicketEnvelopeSchema` plus the `merged` discriminator.
 */
export const WireIssueTicketMergedEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  ticket: WireTicketSchema,
  merged: Schema.Literal(true),
})
