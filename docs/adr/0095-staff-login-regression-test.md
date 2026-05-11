# ADR-0095: Staff login regression test

- Status: Accepted
- Date: 2026-05-12
- Stage: F / S26
- Refines: ADR-0089 (envelope enrichment), the regression
  fix in commit `d141c98`

## Decision

Pin the staff login lifecycle inside the workers-pool
integration test suite end-to-end so the regression that
triggered the obs sprint cannot reappear silently. The new
file `apps/default/test/integration/router/staffLogin.integration.test.ts`
covers two adjacent surfaces:

1. `POST /api/v1/staff/login` — three wire branches:
   - happy path → 200 + Bearer JWT + `__Host-staff_session`
     cookie with `HttpOnly; SameSite=Strict; Path=/`,
   - wrong password (length-mismatch and same-length-bytes-
     different) → 401 + `MissingStaffCapability`,
   - missing `password` field → 422 + `InvalidBody`.
2. `GET /api/v1/queue/feed` — six WS upgrade surfaces:
   - anonymous default,
   - valid Bearer JWT → staff capability,
   - valid `__Host-staff_session` cookie → staff capability,
   - valid legacy `x-staff-token` header → staff capability,
   - malformed Bearer → anonymous fallback (no upgrade reject),
   - bad cookie signature → anonymous fallback.

### Scope split with the unit tests

The 6-failure-reason `debug` discriminant (S21 / ADR-0089)
is dev-mode only — `IS_DEV=0` in `wrangler.toml` means
integration tests get the public envelope (`{_tag, code}`
without `debug`). The discriminant lives in `envelopeEnrichment.test.ts`
which toggles `IS_DEV` directly against the `isDevMode`
predicate.

This file pins the *wire envelope* that production users
see, plus the capability negotiation in
`routes.ts:route_queueFeed`. Together with the unit suite,
the credential surface is covered from the predicate
upward.

### Local helper for header passthrough

The existing `wsClient` harness opens a WS without
header customisation. Staff WS upgrades need to attach
the credential header (Bearer / Cookie / legacy token), so
the test file adds a local `openWebSocketWithHeaders`
helper that wraps `worker().fetch(new Request(...,
{ headers }))` + accept + first-message Promise.

### Why this test, why now

The S22b commit fixed staff login by adding `POST
/staff/login` + vite proxy `/api/*` ws: true + onLogin
flow. That fix was a *direct* repair — there was no test
gate it would have failed before the fix landed. This
regression test exists so the next time someone touches
the cookie / Bearer / proxy flow, a green CI proves the
chain still works.

## Consequences

- The full credential chain (login → cookie set → WS
  upgrade with cookie → staff frame variant arrives) is
  asserted end-to-end inside the workers pool.
- A future regression in the `requireStaff` precedence
  (cookie > bearer > header) surfaces as a failing test
  rather than as a silent "WS upgrades anonymous when it
  should upgrade staff".
- The 6-failure-reason wire-vs-debug split stays cleanly
  partitioned: this file pins the wire, the unit file
  pins the predicate.

## Status

- 2026-05-12 — Test lands in commit `1cb12bd`.
