import { Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import { type DomainError, PhoneMismatchError } from "../../domain/errors/Errors.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"
import type { PhoneLast4 } from "../../domain/value-objects/PhoneLast4.js"
import { BookingCodeIndex } from "../ports/BookingCodeIndex.js"
import { BookingRepository } from "../ports/BookingRepository.js"

/**
 * Self-service authentication for customer mutations.
 *
 * Two-step lookup matches ADR-0014: the bloom-filter index acts as the
 * cheap pre-database guard (rejecting ~99 % of typo'd codes without a
 * round-trip), then the repository resolves the canonical booking. The
 * `phoneLast4` check defends against a code-only enumeration attack —
 * an attacker who guesses a valid code still cannot mutate the booking
 * without the matching weak factor.
 *
 * Returns the resolved {@link Booking} on success. Failure modes:
 *   - bloom miss → `BookingNotFoundError` (skips the database lookup)
 *   - repository miss → `BookingNotFoundError`
 *   - phone mismatch → `PhoneMismatchError`
 *
 * `BookingNotFoundError` and `PhoneMismatchError` deliberately carry no
 * `code` / `phoneLast4` field so the operator's log payload stays
 * PII-clean (ADR-0009).
 */
export const authenticateCustomer = (
  code: BookingCode,
  phoneLast4: PhoneLast4,
): Effect.Effect<Booking, DomainError, BookingRepository | BookingCodeIndex> =>
  Effect.gen(function* () {
    const repo = yield* BookingRepository
    const index = yield* BookingCodeIndex

    const mayContain = yield* index.mayContain(code)
    if (!mayContain) {
      return yield* repo.findByCode(code) // forces the canonical not-found error
    }

    const booking = yield* repo.findByCode(code)
    if (booking.phoneLast4 !== phoneLast4) {
      return yield* Effect.fail(new PhoneMismatchError({}))
    }
    return booking
  })
