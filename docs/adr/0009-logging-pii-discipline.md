# 0009. Logging discipline: PII never appears in any log

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: privacy, observability

## Context

The system collects only the minimum PII it needs (full kana name, last 4 digits of phone). "We don't have data we don't store" is one of the core trust guarantees (SYSTEM.md §2.2). Logs are the most common PII leak channel — any field that ends up in `console.log` or a structured log pipeline becomes long-lived in the operator's tooling.

## Decision

- Logs are **structured JSON only**. No free-form `console.log`. The logger (`packages/core/application/ports/Logger.ts`) accepts a fixed schema:

  ```ts
  type LogEvent = {
    level: "debug" | "info" | "warn" | "error"
    traceId: TraceId
    event: LogEventName  // closed enum
    outcome: "ok" | "rejected" | "error"
    // permitted contextual fields keyed by LogEventName
  }
  ```

- The following field names are **forbidden** anywhere in the log payload tree: `nameKana`, `phoneLast4`, `freeText`, `email`, `mailto`, `phone`, `address`, `birthday`, `gender`, `ip`, `userAgent`, raw IPs, raw UA strings.
- TypeIDs (`book_…`, `prov_…`, …) are permitted — they identify the entity without revealing its PII.
- A CI job (`just pii-guard`) greps for the forbidden tokens across `packages/`, `apps/`, and structured log call sites. New entries to the deny-list go in this ADR.
- Cloudflare Workers Logs default retention (30 days) applies. We do not extend it.

## Consequences

- Logs are safe to share with anyone debugging the system; PII exfiltration via tooling is structurally prevented.
- Operators correlate by `traceId`, not by customer attributes. Tracing happens through TypeIDs.
- Adding a new permitted field requires updating this ADR and the logger schema.

## Alternatives considered

- **Best-effort redaction at the sink**: brittle; one missed field defeats the policy.
- **Per-team review of every log call**: doesn't scale and decays.

## References

- SYSTEM.md §2.2, §4.5.7.
