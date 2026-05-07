import { codeOf, type DomainError, type ErrorSeverity, severityOf } from "./Errors.js"
import type { TraceId } from "./TraceId.js"

/**
 * Phase 0.7-β2 — single derivation point for the four downstream
 * surfaces a `DomainError` has to feed:
 *
 *   1. **i18n key** ({@link errorToI18nKey}) — frontend message
 *      lookup. The `error.<_tag>` shape is a stable contract: every
 *      error class corresponds to exactly one localizable message,
 *      and the type-level invariant is a constant of the project
 *      (no dynamic message construction). Phase 0.11's `paraglide-js`
 *      bundle pulls keys from this single source.
 *   2. **GraphQL union payload** ({@link errorToGraphQLPayload}) —
 *      Pothos `errors` plugin renders this struct as the typed
 *      `__typename` arm in the GraphQL union (Phase 0.7-β4).
 *   3. **Audit-log entry** ({@link errorToAuditEntry}) — the
 *      D1 `audit_log` row written when a staff or customer command is
 *      denied. Phase 0.12's `D1AuditLoggerLive` consumes this shape.
 *   4. **Log payload** ({@link toLogPayload} in `Errors.ts`) — the
 *      structured-log `console.{info,warn,error}` payload, kept
 *      alongside the error class itself because it has been the
 *      historical surface; Phase 0.12's WorkersLogger drains it.
 *
 * Keeping all four derivations in one module makes "what does this
 * error look like to consumer X?" a one-line answer, and prevents
 * downstream surfaces from diverging on the `_tag` / `code` mapping.
 */

declare const I18nKeyBrand: unique symbol
export type I18nKey = string & { readonly [I18nKeyBrand]: never }

/**
 * `error.<_tag>` — the canonical lookup key. Every domain error
 * resolves to exactly one i18n key; `messageformat` placeholders in
 * the bundle handle the dynamic parts (e.g. `reason`).
 */
export const errorToI18nKey = (e: DomainError): I18nKey => `error.${e._tag}` as I18nKey

export type GraphQLErrorPayload = {
  readonly __typename: string
  readonly code: string
  readonly severity: ErrorSeverity
  readonly i18nKey: I18nKey
}

/**
 * Map a `DomainError` to the payload shape Pothos's `errors` plugin
 * renders as the typed GraphQL union arm. The `__typename` is the
 * error's `_tag` (matched by Pothos against the error-type ref); the
 * client gets a stable `code` plus a localizable `i18nKey`.
 */
export const errorToGraphQLPayload = (e: DomainError): GraphQLErrorPayload => ({
  __typename: e._tag,
  code: codeOf(e),
  severity: severityOf(e),
  i18nKey: errorToI18nKey(e),
})

/**
 * Companion to {@link errorToGraphQLPayload} that drives the
 * `extensions` channel of a GraphQL error response. The byte-equal
 * SDL invariant of ADR-0041 is preserved by construction: extensions
 * are wire-only metadata and never appear in the schema's syntactic
 * surface, so widening this function does not change the SDL byte
 * sequence.
 *
 * The redactor is supplied by the caller (in production via the
 * {@link ErrorRedaction} port resolved through {@link RuntimeMode});
 * the function itself is pure so it can be exercised under any
 * fixture without spinning up the Effect runtime. The two-arm
 * structure mirrors `runRpcOrThrow`'s splitter:
 *
 *   1. The originating cause is an `Error` instance — the redactor
 *      decides what (if anything) to propagate to the wire.
 *   2. The originating cause is a `DomainError` — the canonical tag
 *      is propagated under `originalTag`, no cause preview because
 *      the field surface (`code` / `severity` / `i18nKey`) already
 *      carries the operator-relevant data.
 */
export const errorToGraphQLExtensions = (
  cause: unknown,
  redact: (cause: unknown) => Record<string, unknown>,
): Record<string, unknown> => {
  if (cause === undefined || cause === null) return {}
  const tagged = cause as { readonly _tag?: unknown }
  const originalTag = typeof tagged._tag === "string" ? tagged._tag : undefined
  const causeFields = redact(cause)
  const hasCause = Object.keys(causeFields).length > 0
  return {
    ...(hasCause ? { cause: causeFields } : {}),
    ...(originalTag !== undefined ? { originalTag } : {}),
  }
}

export type AuditActor = "customer" | "staff" | "system"

export type AuditContext = {
  readonly now: string
  readonly actor: AuditActor
  readonly traceId?: TraceId
}

export type AuditEntry = {
  readonly ts: string
  readonly actor: AuditActor
  readonly outcome: "denied"
  readonly errorTag: string
  readonly errorCode: string
  readonly traceId?: TraceId
}

/**
 * Render a `DomainError` as the audit row that's written when a
 * command is denied. PII-clean by construction (errors only carry
 * codes and operator-facing reason strings; the audit table mirrors
 * that contract).
 */
export const errorToAuditEntry = (e: DomainError, ctx: AuditContext): AuditEntry => {
  const base = {
    ts: ctx.now,
    actor: ctx.actor,
    outcome: "denied" as const,
    errorTag: e._tag,
    errorCode: codeOf(e),
  }
  return ctx.traceId !== undefined ? { ...base, traceId: ctx.traceId } : base
}
