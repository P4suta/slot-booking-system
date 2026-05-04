# 0002. Booking code entropy and encoding

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: domain, security

## Context

Customers identify their reservation with a short code that they can read aloud, type on a phone, or scribble on paper. The code is the only artefact a customer keeps, paired with the last 4 digits of their phone number. We need it short enough to memorise, long enough to resist brute-forcing, and resistant to confusion between visually similar characters.

## Decision

A booking code is **6 random Crockford Base32 characters + 1 checksum character** (Crockford `mod 37` checksum), surfaced to humans as `XXXX-XXX`.

- Random part: 32^6 ≈ 1.07 × 10^9 possibilities.
- Crockford alphabet: `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no `I`, `L`, `O`, `U`).
- Input normalisation: strip dashes, uppercase, fold `O→0`, `I→1`, `L→1`.
- Checksum: 1 character chosen from the 37-char extended alphabet so the code matches `value mod 37 == 0`.
- Display format: `XXXX-XXX` (4 + 3) — the dash is presentational only.

Customer authorisation also requires the matching `phoneLast4` (10^4 possibilities) and a Cloudflare rate limit (5 req/min/IP). Combined search space against an authorised pair is ≈ 10^13.

## Consequences

- Cheap brute-force is infeasible: at 5 req/min/IP, ~10^7 years to exhaust.
- 99 % of typos are rejected by the checksum **before** the database is consulted, dropping read load and reducing brute-force surface.
- The 7-character form fits on a printed slip and reads aloud cleanly.
- Adding a single character later (32^7 ≈ 3.4 × 10^10) is non-breaking — old 6+1 codes remain valid as a subset.

## Alternatives considered

- **UUIDv4 surfaced verbatim**: 36 chars, unfriendly to memorise/dictate.
- **TypeID `book_…`**: internal IDs are TypeIDs already, but exposing them adds a 26-character ULID body — too long.
- **Numeric-only PIN (e.g., 8 digits)**: easier to mistype, smaller search space, no checksum unless added explicitly.

## References

- SYSTEM.md §2.1, §4.5.8.
- Crockford Base32 specification.
