/**
 * `POST /api/v1/__/client-error` — receive client-side
 * observability reports (S22 / ADR-0090).
 *
 * The web side (`apps/web/src/lib/obs/reporter.ts`) batches every
 * `warning` / `error` `DevEvent` from the client ring buffer and
 * POSTs them here. The handler:
 *
 *   1. Decodes the payload through a Schema (boundary safety),
 *   2. Caps batch size (DoS defence: a misbehaving / hostile
 *      client cannot flood the log surface),
 *   3. Emits one `ClientReport` structured-log line per event
 *      (severity-filtered console.warn / console.error) — the
 *      operator dashboard joins these with `HttpRequest` /
 *      `HttpEnvelope` on `traceId`,
 *   4. Returns 204 No Content so the reporter does not retain a
 *      response payload.
 *
 * Trust model: this endpoint is unauthenticated by design. The
 * client surface is best-effort observability, not an audit
 * channel — every reported event is *redacted-at-source* by the
 * web reporter, the schema rejects anything bigger than the cap,
 * and the structured log marks the entry as `clientSourced: true`
 * so the operator can never mistake it for a server-derived fact.
 *
 * Production keeps the endpoint live (per ADR-0085 user
 * decision: "全 obs surface prod も keep") so real users' crashes
 * surface in the same log pipeline. The dev-only inspect panel
 * (Stage 23) reads the same stream.
 */
import { Schema } from "effect"
import { emitStructuredLog } from "./devLogTap.js"

/**
 * Maximum events accepted in a single POST body. The web reporter
 * coalesces at most 1 second; under typical use that's ≤ 8 events
 * per batch. 64 leaves head-room for burst (page mount + first
 * fetch + first WS frame + UncaughtError + …) without giving a
 * misbehaving client room to drown the log line.
 */
const CLIENT_REPORT_MAX_EVENTS = 64

/**
 * Schema for the body the web reporter sends. Each event is loose-
 * shaped (`Schema.Unknown` for the inner DevEvent) so the server
 * doesn't have to mirror the discriminated union — the client is
 * the schema owner, the server just relays the structured-log
 * line. The wrapping keys (`sessionId`, `ua`) carry the join
 * context the operator needs.
 */
export const ClientReportSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.makeFilter((s: string) => s.length > 0 && s.length <= 64)),
  ua: Schema.String.check(Schema.makeFilter((s: string) => s.length <= 256)),
  events: Schema.Array(Schema.Unknown).check(
    Schema.makeFilter(
      (arr: readonly unknown[]) => arr.length > 0 && arr.length <= CLIENT_REPORT_MAX_EVENTS,
    ),
  ),
})

export type ClientReport = Schema.Schema.Type<typeof ClientReportSchema>

/**
 * Emit one structured-log entry per client event. Severity gates
 * the level (`error` → `console.error`, `warning` → `console.warn`).
 * The `clientSourced: true` flag prevents an operator dashboard
 * from confusing client-reported facts with server-derived ones.
 */
export const emitClientReport = (report: ClientReport, traceId: string | null): void => {
  for (const event of report.events) {
    const e = event as { readonly kind?: unknown; readonly severity?: unknown }
    const severity = typeof e.severity === "string" ? e.severity : "info"
    const line = JSON.stringify({
      _tag: "ClientReport",
      code: "I_CLIENT_REPORT",
      severity: "infrastructure",
      clientSourced: true,
      sessionId: report.sessionId,
      ua: report.ua,
      event,
      traceId,
    })
    emitStructuredLog(severity === "error" ? "error" : "warn", line)
  }
}
