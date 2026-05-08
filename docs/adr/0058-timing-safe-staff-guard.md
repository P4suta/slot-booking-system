# ADR-0058: Constant-time staff token comparison

- Status: Accepted
- Date: 2026-05-09
- Refines: ADR-0055 (staff single capability)

## Decision

The staff capability check folds the presented token through a
WebCrypto-only constant-time comparator
(`apps/default/src/server/security/timingSafeEqual.ts`) instead
of the JS-native `presented !== secret`. The implementation is a
single XOR-fold over the encoded UTF-8 bytes; the length-mismatch
branch runs *before* the secret reaches the comparator, so the
only observable timing-leak surface is the invariant length of
the encoded form (a public fact already known to the operator).

## Context

The pre-pivot staff guard used direct string comparison:

```ts
if (presented !== secret) return MissingStaffCapability
```

The JS comparator short-circuits on the first mismatching byte,
which leaks the secret prefix length via response timing. With
~5 microseconds of jitter discrimination — achievable from a
co-located edge node — an attacker can iterate prefix-by-prefix
and recover the secret in O(n × 256) probes per byte. CWE-208
("Observable Timing Discrepancy") lists this as the canonical
class.

Workers does not expose `node:crypto.timingSafeEqual` (no Node
runtime), and `crypto.subtle.timingSafeEqual` is a non-standard
proposal absent from the V8 build the runtime ships. The remedy
is the inline implementation: TextEncoder → byte arrays →
XOR fold → `diff === 0`. The fold's loop body is data-independent
at the branch level (no early exit), and the length check happens
on the *encoded byte length*, not the secret material.

## Consequences

- A timing-side-channel guess against the staff token is no
  longer feasible from production. Local-dev wrangler runs unchanged.
- The helper is reusable: future cookie-session validation
  (ADR-0055 future work) can fold the cookie payload through the
  same comparator without re-implementing the constant-time loop.
- Property tests
  (`apps/default/test/server/security/timingSafeEqual.test.ts`)
  pin the equivalence with `===` across an 8-string fixture
  matrix, every single-byte position mutation, and the empty +
  non-ASCII edge cases. The timing guarantee itself is not
  directly observable from CI but the structural correctness is
  pinned.

Superseded-By:
