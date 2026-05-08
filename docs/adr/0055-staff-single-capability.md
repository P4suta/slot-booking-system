# ADR-0055: Staff single capability (`operate_queue`)

- Status: Accepted (with future work)
- Date: 2026-05-08
- Refines: ADR-0033 (capability newtype, slot-graph era)

## Decision

Staff authentication ships in two stages. Phase 4 of the queue pivot
lands the **shared-secret** stage; the **session-based** stage is
recorded here as future work.

### Phase 4 (shipped)

- `STAFF_SESSION_SECRET` is a deployment env var (rotated via
  `wrangler secret put`). The staff dashboard prompts the operator
  for the secret on first visit; the value is stashed in
  `localStorage` under `queue.staffToken` and sent on every staff
  request as `x-staff-token: <secret>`.
- The `requireOperateQueue` guard in
  `apps/default/src/server/api/queue.ts` fails closed
  (`MissingStaffCapability` with the matching `reason`) when the
  header is absent or wrong.
- The slot-graph's five-element `StaffScope` lattice (`cancel`,
  `reschedule`, `complete`, `noshow`, `manage_catalog`) shrinks to a
  single `operate_queue` scope. The bounded-join-semilattice
  machinery in `domain/auth/ScopeSet.ts` is preserved for future
  expansion; the `Bitmap`-backed implementation is replaced by a
  `ReadonlySet<StaffScope>` since 1-bit lattices do not benefit from
  the bitmap layout.

### Phase 5 follow-up (shipped)

- `POST /api/v1/staff/login` exchanges the deployment secret for
  two surfaces in one round trip: an HS256 JWT in the response
  body (`Authorization: Bearer <token>` for API consumers) and an
  HMAC-signed `__Host-staff_session` cookie (HttpOnly, Secure,
  SameSite=Strict, Path=/) for the staff dashboard. Both share an
  8-hour TTL.
- `requireStaff` (`apps/default/src/server/http/router.ts`)
  accepts three credential surfaces: the legacy `x-staff-token`
  header, a Bearer JWT, or the cookie session. Each is verified
  through a constant-time path (`timingSafeEqual` for the legacy
  header, `jose.jwtVerify` for the JWT, `verifySession` —
  itself folding through `timingSafeEqual` — for the cookie).
- The JWT carries `{ sub: "staff", capabilities:
  ["operate-queue"], iss, aud, exp, iat }`; the cookie carries
  the same shape minus the JWT-specific iss / aud claims.
- The D1 `staff_session` table + scrypt password hashing are
  still future work; the current login compares against the
  deployment-wide `STAFF_SESSION_SECRET` rotated through
  `wrangler secret put`. A multi-staff catalog with per-account
  capabilities lands when the operational surface needs it.

## Consequences

- A staff dashboard with the wrong (or absent) header gets a 401 /
  503 and is forced through the login form. There is no graceful
  degradation — staff actions are gated.
- The migration to cookie sessions is straightforward: the
  `Capability` shape and `requireOperateQueue` guard do not change;
  only the credential extraction site (header → cookie) moves.
