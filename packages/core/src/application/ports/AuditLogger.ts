import { Context, type Effect } from "effect"
import type { AuditEntry } from "../../domain/errors/derivations.js"

/**
 * Audit-log port. Phase 0.7-γ3 ships the interface only; the
 * `D1AuditLoggerLive` implementation lands in Phase 0.12 alongside
 * the rest of the observability surface.
 *
 * Distinct from {@link Logger}: that port writes structured
 * developer-facing payloads to `console`; this port writes
 * staff/customer action records (denied or accepted) to the D1
 * `audit_log` table for long-retention forensics. The two surfaces
 * never share a sink.
 *
 * `write` accepts the {@link AuditEntry} shape produced by the
 * `errorToAuditEntry` derivation in `domain/errors/derivations.ts`,
 * so the boundary contract for the failure case is fixed; success
 * audit rows extend the same shape with `outcome: "accepted"` once
 * Phase 0.12 wires the success path.
 */
export class AuditLogger extends Context.Service<
  AuditLogger,
  {
    readonly write: (entry: AuditEntry) => Effect.Effect<void>
  }
>()("@booking/core/AuditLogger") {}
