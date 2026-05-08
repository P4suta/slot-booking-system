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

### Future work (recorded but not shipped)

- Replace the shared header with a cookie-backed session: `scrypt`
  password hashing, `jose` HS256 JWT signed under
  `STAFF_SESSION_SECRET`, `__Host-staff_session` cookie with
  `SameSite=Strict; HttpOnly; Secure`.
- D1 `staff_session` table: `(staff_id, password_hash,
  capability_scopes, created_at, updated_at)`.
- `Mutation.staffLogin` (or REST `POST /api/v1/auth/staff-login`)
  exchanging credentials for a session token.

The Iron-Principles "zero external deps" rule already permits
`@noble/hashes` (scrypt) and `jose` (JWT) as workers-compatible
mainstream packages.

## Consequences

- A staff dashboard with the wrong (or absent) header gets a 401 /
  503 and is forced through the login form. There is no graceful
  degradation — staff actions are gated.
- The migration to cookie sessions is straightforward: the
  `Capability` shape and `requireOperateQueue` guard do not change;
  only the credential extraction site (header → cookie) moves.
