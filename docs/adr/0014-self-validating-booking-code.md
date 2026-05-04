# 0014. Booking-code input is rejected before any database lookup

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: security, performance

## Context

Customers re-enter their booking code at the cancel / reschedule screen. Most inputs are typos. Hitting the database for every typo wastes round-trips, raises log noise, and gives adversaries a free oracle for brute force.

## Decision

The booking-code parser is a **pure** function `BookingCode.parse(input: string): Either<ParseError, BookingCode>`:

1. Strip the presentational dash, uppercase, and apply the Crockford confusable folding (`O→0`, `I→1`, `L→1`).
2. Verify the result is exactly 7 characters and every character belongs to the Crockford alphabet.
3. Verify the mod-37 checksum (ADR-0002).
4. Only on success does the result become a branded `BookingCode` and the database lookup is allowed.

Steps 1–3 reject ~99 % of typos and **all** non-Crockford inputs without touching the database or the DO.

## Consequences

- The reschedule / cancel happy path is one round trip, the typo case is zero.
- Brute-force surface is reduced: random 7-character strings have ≈ 1/37 chance of passing the checksum. Combined with rate limits and `phoneLast4`, the search budget is tiny.
- The parser is easy to property-test: feed random strings, every reject path classifies the error.

## Alternatives considered

- **Lookup first, parse later**: invites SQL injection risk, leaks shape, wastes capacity.
- **Server-side parse only**: forces the customer to wait for the network on a typo; we lose the cheap fast-feedback.

## References

- SYSTEM.md §2.5, §4.5.8, §7.4.
- ADR-0002 (booking-code entropy).
