import { Context, type Effect } from "effect"
import type { AuditEntry } from "../../domain/errors/derivations.js"

/**
 * Audit-log port. Distinct from {@link Logger}: that port writes
 * structured developer-facing payloads to `console`; this port writes
 * staff/customer action records (denied or accepted) to the D1
 * `audit_log` table for long-retention forensics. The two surfaces
 * never share a sink.
 *
 * `write` accepts the {@link AuditEntry} shape produced by the
 * `errorToAuditEntry` derivation in `domain/errors/derivations.ts`.
 */
export class AuditLogger extends Context.Service<
  AuditLogger,
  {
    readonly write: (entry: AuditEntry) => Effect.Effect<void>
  }
>()("@booking/core/AuditLogger") {}
