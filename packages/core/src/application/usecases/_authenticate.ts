import { Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import { type DomainError, PhoneMismatchError } from "../../domain/errors/Errors.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"
import type { PhoneLast4 } from "../../domain/value-objects/PhoneLast4.js"
import { BookingCodeIndex } from "../ports/BookingCodeIndex.js"
import {
  BookingEventSourcedRepository,
  type LoadedAggregate,
} from "../ports/EventSourcedRepository.js"

/**
 * Self-service authentication for customer mutations.
 *
 * Two-step lookup matches ADR-0014: the bloom-filter / SQL-unique index
 * is the cheap pre-database guard (rejecting ~99 % of typo'd codes
 * without a fold), then the repository's `findByKey` resolves the
 * canonical aggregate id, and `load` folds the event log into the
 * current snapshot. The `phoneLast4` check defends against a code-only
 * enumeration attack — an attacker who guesses a valid code still
 * cannot mutate the booking without the matching weak factor.
 *
 * Returns the {@link LoadedAggregate} so the caller can pass `revision`
 * into the next `save` and assert no concurrent writer slipped in.
 *
 * Failure modes:
 *   - bloom miss → `AggregateNotFoundError` (skips the database lookup)
 *   - findByKey miss → `AggregateNotFoundError`
 *   - load miss → `AggregateNotFoundError`
 *   - phone mismatch → `PhoneMismatchError`
 *
 * `AggregateNotFoundError` and `PhoneMismatchError` deliberately carry
 * no `code` / `phoneLast4` field so the operator's log payload stays
 * PII-clean (ADR-0009).
 */
export const authenticateCustomer = (
  code: BookingCode,
  phoneLast4: PhoneLast4,
): Effect.Effect<
  LoadedAggregate<Booking>,
  DomainError,
  BookingEventSourcedRepository | BookingCodeIndex
> =>
  Effect.gen(function* () {
    const repo = yield* BookingEventSourcedRepository
    const index = yield* BookingCodeIndex

    const mayContain = yield* index.mayContain(code)
    if (!mayContain) {
      // Force the canonical not-found path so callers see a uniform
      // failure tag regardless of which guard rejected first.
      return yield* repo.findByKey(code).pipe(Effect.flatMap(repo.load))
    }

    const id = yield* repo.findByKey(code)
    const loaded = yield* repo.load(id)
    if (loaded.state.phoneLast4 !== phoneLast4) {
      return yield* Effect.fail(new PhoneMismatchError({}))
    }
    return loaded
  })
