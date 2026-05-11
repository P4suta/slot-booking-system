# ADR-0090: Client error report endpoint `/api/v1/__/client-error`

- Status: Accepted
- Date: 2026-05-12
- Stage: F / S22a
- Refines: ADR-0088 (client obs ring + reporter)

## Decision

Land the server-side terminus of the client reporter (S20 /
ADR-0088): `POST /api/v1/__/client-error` accepts a batched
`ClientReport` payload and emits one structured-log line per
event into the same `console.{warn,error}` sink the rest of
the worker uses. Unauthenticated by design — observability
is best-effort, not an audit channel.

```ts
// obs/clientReport.ts
export const ClientReportSchema = Schema.Struct({
  sessionId: Schema.String.check(/* len 1..64 */),
  ua:        Schema.String.check(/* len ≤ 256 */),
  events:    Schema.Array(Schema.Unknown).check(/* len 1..64 */),
})
```

### Trust model

The endpoint is unauthenticated for two reasons:

1. The reporter must work even when the user has *no*
   credentials (anonymous customer hitting an UncaughtError
   on the issue flow). Adding auth would silently lose those
   reports.
2. Every event reaching the endpoint has already passed
   through the client reporter's `sanitise()` step
   (ADR-0088) — `nameKana` / `phoneLast4` / `freeText` are
   redacted at source. The server never sees PII regardless
   of what the event variant claims to carry.

Defence-in-depth: the structured-log line marks every
relayed event with `clientSourced: true` so the operator
dashboard cannot confuse client-asserted facts with server-
derived ones; the schema rejects bodies above the cap so a
misbehaving / hostile client cannot flood the log channel.

### Production posture

The endpoint stays live in production (user spec: "全 obs
surface prod も keep"). Real users' uncaught errors surface
in the same structured-log pipeline as server-side errors,
so the on-call can pivot from a customer's 「ページが壊れて
います」 ticket to the structured-log row via the session
id + trace id pair.

### Severity gating

Each event's `severity` (set by the bus at emit time, see
ADR-0088) drives the console sink:

- `severity === "error"` → `console.error`
- otherwise (including `"warning"`) → `console.warn`

`info` / `debug` events never reach the endpoint because
the client reporter filters them at the boundary (S20 /
`isReportable`).

## Consequences

- The reporter's POST has a real terminus. Its 1-second
  coalesce window means roughly one log burst per error
  storm rather than one per event.
- The shape of `ClientReportSchema` is deliberately
  loose-typed at the boundary (each event is
  `Schema.Unknown`); the server is the *relay*, not the
  schema owner. If the event shape needs to gain a new
  field, the change is in one place (client `events.ts`)
  and the server transparently passes it through.
- `route_clientError` returns 204 No Content so the reporter
  does not retain a response body.

## Status

- 2026-05-12 — Endpoint lands in commit `93c8168`. ADR
  drafted inline in commit message; ADR file followed in
  the obs sprint cleanup.
