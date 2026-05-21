import {
  firstFailedFieldKey,
  InstantSchema,
  LaneSchema,
  NameKanaSchema,
  PhoneLast4Schema,
  PlainDateSchema,
  SlotGranularitySchema,
  TicketIdSchema,
} from "@booking/core"
import { Schema, type SchemaIssue } from "effect"

/**
 * HTTP boundary schemas — domain branded value-objects composed
 * directly into the request / query Structs.
 *
 * Decoding here is the **single normalisation point** for every
 * customer-supplied identifier:
 *   - `NameKanaSchema` runs NFKC + whitespace collapse + trim before
 *     the brand check;
 *   - `PhoneLast4Schema` enforces `^[0-9]{4}$`;
 *   - `TicketIdSchema` enforces `^tkt_[0-9a-z]{26}$`.
 *
 * Downstream stages (DO dispatch + ticket comparison) only ever see
 * branded values from a single source of truth, so the
 * `IssueTicket` and `GetMyTicket` paths converge on the *same*
 * canonical form. The 2026-05-09 asymmetric-`PhoneMismatch` bug
 * (issue normalised, my-ticket compared raw) is structurally
 * impossible: the comparator cannot receive a non-canonical value.
 *
 * The boundary also doubles as the API-direct attack surface:
 * unbounded strings, non-digit phones, alien kana never reach the
 * comparator — they are rejected at decode with a 422 envelope.
 */

const FreeTextOrNull = Schema.NullOr(Schema.String)

/**
 * Customer-supplied cancellation reason. The pair (1, 200] caps a
 * worst-case payload (16-bit chars × 200 = ~400 bytes) without
 * cutting off legitimate prose; an empty string is rejected so the
 * audit trail always carries a non-trivial justification.
 */
const ReasonSchema = Schema.String.check(
  Schema.makeFilter((s: string) => s.length > 0 && s.length <= 200),
)

export const IssueTicketBodySchema = Schema.Struct({
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  freeText: FreeTextOrNull,
  lane: Schema.optional(LaneSchema),
  // ADR-0066. The HTTP boundary enforces the round-trip invariant
  // `lane === "reservation" ⇔ appointmentAt !== null` at the use-
  // case (AppointmentRequiredForReservationLaneError); the Schema
  // takes both fields independently so the mismatch surfaces as a
  // 422 boundary error rather than a generic InvalidPayload.
  appointmentAt: Schema.optional(InstantSchema),
})

/**
 * `POST /api/v1/queue/call-next` accepts an optional `lane` body
 * (ADR-0062). An empty body means "preferred-lane chain default".
 */
export const CallNextBodySchema = Schema.Struct({
  lane: Schema.optional(LaneSchema),
})

/**
 * `POST /api/v1/queue/call-specific` (ADR-0065).
 */
export const CallSpecificBodySchema = Schema.Struct({
  ticketId: TicketIdSchema,
})

/**
 * `POST /api/v1/queue/call-batch` (ADR-0065). The schema enforces a
 * non-empty array at the boundary so the use case can return an
 * `InvalidBody` envelope rather than letting the empty input slip
 * through to the DO.
 */
const NonEmptyTicketIdArraySchema = Schema.Array(TicketIdSchema).check(
  Schema.makeFilter((arr: readonly unknown[]) => arr.length > 0),
)

export const CallBatchBodySchema = Schema.Struct({
  ticketIds: NonEmptyTicketIdArraySchema,
})

/**
 * `POST /api/v1/queue/reorder` (ADR-0065). `afterTicketId === null`
 * means "lane head".
 */
export const ReorderBodySchema = Schema.Struct({
  ticketId: TicketIdSchema,
  afterTicketId: Schema.NullOr(TicketIdSchema),
})

export const MyTicketQuerySchema = Schema.Struct({
  ticketId: TicketIdSchema,
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
})

/**
 * `GET /api/v1/tickets/by-handle?k&p` (ADR-0069). The customer-side
 * recovery primitive: the handle alone (no ticketId) resolves to the
 * single active ticket the customer has. The use case enforces handle
 * uniqueness across the active set, so the response is at most one
 * ticket; 404 means "no active ticket for this handle".
 */
export const ByHandleQuerySchema = Schema.Struct({
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
})

/**
 * `POST /api/v1/tickets/:id/reschedule` body (customer path,
 * ADR-0070). Customer presents the handle for self-service auth +
 * the new `newAppointmentAt`. Staff path omits the handle fields
 * (validated by `x-staff-token` middleware).
 */
export const RescheduleBodySchema = Schema.Struct({
  nameKana: Schema.optional(NameKanaSchema),
  phoneLast4: Schema.optional(PhoneLast4Schema),
  newAppointmentAt: Schema.String,
})

export const CancelBodySchema = Schema.Struct({
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  reason: ReasonSchema,
})

export const StaffCancelBodySchema = Schema.Struct({
  reason: ReasonSchema,
})

/** Endpoint URL upper bound; real push services emit < 256 bytes,
 *  so 2048 is comfortably defensive without locking out future hosts. */
const PushEndpointSchema = Schema.String.check(Schema.isMaxLength(2048))

/**
 * `POST /api/v1/tickets/:id/push-subscription` body (ADR-0073 / ADR-0074).
 * Carries the browser's PushSubscription shape (endpoint + ECDH keys)
 * plus the customer handle. The handle is required so the DO can
 * verify that the caller is the actual ticket holder (cancel-pattern
 * parity); without it, anyone with a leaked `ticketId` could register
 * a subscription on behalf of someone else.
 *
 * `endpoint` is validated separately at the route boundary against
 * the known push-service origins.
 */
export const PushSubscriptionBodySchema = Schema.Struct({
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  endpoint: PushEndpointSchema,
  p256dh: Schema.String,
  auth: Schema.String,
})

/**
 * `DELETE /api/v1/tickets/:id/push-subscription` query — the
 * customer-side unsubscribe button passes `?endpoint=...&nameKana=...&
 * phoneLast4=...` so the row deletion targets the correct device row
 * (a single ticket may have rows from multiple devices). DELETE bodies
 * are not portable across user-agents per HTTP convention, so handle
 * verification travels in the query string instead.
 */
export const PushSubscriptionDeleteQuerySchema = Schema.Struct({
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  endpoint: PushEndpointSchema,
})

/**
 * `GET /api/v1/slots?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=30`
 * (ADR-0066 / ADR-0068). Returns `[ { slot, capacity, taken,
 * available }, … ]` for the requested calendar range.
 */
export const SlotsQuerySchema = Schema.Struct({
  from: PlainDateSchema,
  to: PlainDateSchema,
  granularity: SlotGranularitySchema,
})

/**
 * Decode-failure → response envelope. The boundary returns
 * `{ status, tag, code }` derived from the *first failed top-level
 * key* in the SchemaIssue tree.
 *
 * The `ticketId` mapping deliberately collapses to
 * `TicketNotFound` 404 rather than `InvalidEntityId` 422 — the
 * router treats malformed and missing-from-storage ids the same
 * (uniform response avoids leaking parse-vs-storage distinction
 * to enumeration probes).
 *
 * A root-level failure (entire body wrong type / missing required
 * field at the top struct) falls back to `InvalidBody`.
 */
export type DecodeFailureEnvelope = {
  readonly status: number
  readonly tag: string
  readonly code: string
}

const FIELD_FAILURE_MAP = {
  ticketId: { status: 404, tag: "TicketNotFound", code: "E_DOM_TICKET_NOT_FOUND" },
  ticketIds: { status: 422, tag: "InvalidBody", code: "E_VAL_BODY" },
  afterTicketId: { status: 404, tag: "TicketNotFound", code: "E_DOM_TICKET_NOT_FOUND" },
  nameKana: { status: 422, tag: "InvalidNameKana", code: "E_VAL_NAME_KANA" },
  phoneLast4: { status: 422, tag: "InvalidPhoneLast4", code: "E_VAL_PHONE_LAST4" },
  freeText: { status: 422, tag: "InvalidFreeText", code: "E_VAL_FREE_TEXT" },
  lane: { status: 422, tag: "InvalidLane", code: "E_VAL_LANE" },
  appointmentAt: { status: 422, tag: "InvalidPayload", code: "E_VAL_PAYLOAD" },
  from: { status: 422, tag: "InvalidPayload", code: "E_VAL_PAYLOAD" },
  to: { status: 422, tag: "InvalidPayload", code: "E_VAL_PAYLOAD" },
  granularity: { status: 422, tag: "InvalidPayload", code: "E_VAL_PAYLOAD" },
} as const satisfies Record<string, DecodeFailureEnvelope>

const ROOT_FAILURE: DecodeFailureEnvelope = {
  status: 422,
  tag: "InvalidBody",
  code: "E_VAL_BODY",
}

/**
 * `Schema.decodeUnknownResult` returns `Result<Type, Issue.Issue>`
 * — the failure value is the issue tree itself (no `SchemaError`
 * wrapper at the Result level; the wrapper only appears in the
 * Effect / Promise variants of the parser API).
 */
export const dispatchDecodeFailure = (issue: SchemaIssue.Issue): DecodeFailureEnvelope => {
  const field = firstFailedFieldKey(issue)
  if (field !== undefined && field in FIELD_FAILURE_MAP) {
    return FIELD_FAILURE_MAP[field as keyof typeof FIELD_FAILURE_MAP]
  }
  return ROOT_FAILURE
}

/**
 * Path-parameter `:id` decoder. Re-exported so the router can
 * lift a path TicketId through the same schema the boundary
 * Structs use, keeping a single source of truth for the prefix +
 * ULID shape.
 */
export const decodeTicketIdParam = Schema.decodeUnknownResult(TicketIdSchema)
