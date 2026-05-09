import {
  firstFailedFieldKey,
  NameKanaSchema,
  PhoneLast4Schema,
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
})

export const MyTicketQuerySchema = Schema.Struct({
  ticketId: TicketIdSchema,
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
})

export const CancelBodySchema = Schema.Struct({
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  reason: ReasonSchema,
})

export const StaffCancelBodySchema = Schema.Struct({
  reason: ReasonSchema,
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
  nameKana: { status: 422, tag: "InvalidNameKana", code: "E_VAL_NAME_KANA" },
  phoneLast4: { status: 422, tag: "InvalidPhoneLast4", code: "E_VAL_PHONE_LAST4" },
  reason: { status: 422, tag: "InvalidReason", code: "E_VAL_REASON" },
  freeText: { status: 422, tag: "InvalidFreeText", code: "E_VAL_FREE_TEXT" },
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
