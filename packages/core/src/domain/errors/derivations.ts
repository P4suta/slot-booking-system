import { codeOf, type DomainError } from "./Errors.js"
import type { TraceId } from "./TraceId.js"

/**
 * Single derivation point for the downstream surfaces a `DomainError`
 * has to feed:
 *
 *   1. {@link errorToI18nKey} — frontend message lookup. The
 *      `error.<_tag>` shape is a stable contract and the only
 *      source of i18n keys for paraglide-js.
 *   2. {@link errorToAuditEntry} — D1 `audit_log` row written when a
 *      staff or customer command is denied.
 *
 * The HTTP envelope projection (`errorToHttpEnvelope`) lives next to
 * the Hono router under `apps/default/src/server/http/`.
 */

declare const I18nKeyBrand: unique symbol
export type I18nKey = string & { readonly [I18nKeyBrand]: never }

export const errorToI18nKey = (e: DomainError): I18nKey => `error.${e._tag}` as I18nKey

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
