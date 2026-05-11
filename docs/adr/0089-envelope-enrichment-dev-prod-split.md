# ADR-0089: Server envelope enrichment — dev verbose / prod redact

- Status: Accepted
- Date: 2026-05-11
- Stage: F / S21
- Refines: ADR-0088 (client obs ring + reporter)

## Decision

Widen every JSON error envelope with a sanitised `debug`
context object when `IS_DEV === "1"`; production responses
stay byte-for-byte the same as before (`{ ok: false, error:
{ _tag, code } }`). The `debug` field carries discriminated
reasons + integer character counts + 4-char head/tail
previews — enough context for the operator to tell three
otherwise-indistinguishable root causes apart, without
leaking the underlying secret.

```ts
// errorEnvelope.ts
export type DebugEnvelope = {
  readonly reason: string  // closed discriminant (e.g. "bearer_invalid")
  readonly receivedLen?: number
  readonly expectedLen?: number
  readonly receivedHead?: string  // ≤ 4 chars
  readonly receivedTail?: string  // ≤ 4 chars
  readonly field?: string  // boundary's firstFailedFieldKey output
  readonly hint?: string
}

export const isDevMode = (env: { readonly IS_DEV?: string }): boolean =>
  env.IS_DEV === "1"
```

### Staff guard failure surface

The `requireStaff` helper in `_shared.ts` returns a tagged
union covering six failure reasons:

```ts
type StaffGuardFailureReason =
  | "secret_missing"     // STAFF_SESSION_SECRET unset on the deployment
  | "credential_absent"  // no header / bearer / cookie presented
  | "header_mismatch"    // x-staff-token ≠ secret
  | "bearer_malformed"   // Authorization header not in `Bearer X` form
  | "bearer_invalid"     // Bearer JWT failed jose verification
  | "cookie_invalid"     // session cookie HMAC / payload bad
```

The wire envelope uniformly returns 401 + `MissingStaffCapability`
for every failure (an attacker cannot distinguish them), but
the dev-mode `debug.reason` carries the discriminant — the
single most useful piece of context when 「ログインできない」
turns out to be 「I pasted the secret with a leading newline」.

### Why three preview fields

Three structurally-different mistakes produce three different
shapes:

- `receivedLen !== expectedLen` → typo, wrong length.
- `receivedLen === expectedLen` + `receivedHead` differs →
  pasted-from-the-wrong-line, the prefix is wrong.
- `receivedLen === expectedLen` + `receivedTail` differs →
  trailing newline / whitespace, the suffix is wrong.

Four characters is the boundary between "useful preview" and
"useful prefix oracle for brute force" — the dev surface
needs to know which side of the secret the bytes diverge,
not the bytes themselves.

### Structured-log entry

Every error response emits a structured `HttpEnvelope` log
line (`logHttpEnvelope` in `errorEnvelope.ts`). The shape
mirrors `HttpRequest` / `WorkersLoggerLive` so the operator
dashboard filters on `_tag` / `errorTag` / `traceId` without
per-source regex.

## Consequences

- The login handler's 401 path (`auth/login.ts`) carries
  enough sanitised context that an operator can recover
  the right secret without trial-and-error.
- The `route_clientError` handler (S22a) attaches client-
  reported errors to the same structured-log channel; the
  dashboard joins client + server entries on `traceId`.
- Tests (`envelopeEnrichment.test.ts`) pin the dev/prod
  envelope shapes plus `isDevMode` predicate exhaustively.
- The 6-failure-reason union is closed (`exhaustive`) — a
  new credential surface must add a case here and every
  consumer's switch.

## Status

- 2026-05-11 — Envelope enrichment lands in commit `eb5e071`.
  ADR drafted inline in commit message; ADR file followed
  in the obs sprint cleanup (2026-05-12).
