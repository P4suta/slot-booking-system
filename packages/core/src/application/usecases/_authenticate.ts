import { Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import { type DomainError, PhoneMismatchError } from "../../domain/errors/Errors.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"
import type { PhoneLast4 } from "../../domain/value-objects/PhoneLast4.js"
import {
  BookingEventSourcedRepository,
  type LoadedAggregate,
} from "../ports/EventSourcedRepository.js"

/**
 * Self-service authentication for customer mutations.
 *
 * `repo.findByKey` is an exact O(1) lookup against the secondary index
 * the persistence layer maintains in lockstep with `save` (DO local
 * SQLite UNIQUE column + in-memory STM TMap), so the previous bloom-
 * filter pre-screen (Phase 0.5) is gone — the bloom's only job was to
 * dodge a slow lookup, but the lookup is now trivially cheap. Removing
 * the indexer port also drops a probabilistic data structure (with
 * non-zero false-positive rate) from the architecture in favour of a
 * deterministic exact match (ADR-0033).
 *
 * The `phoneLast4` check defends against a code-only enumeration attack
 * — an attacker who guesses a valid code still cannot mutate the booking
 * without the matching weak factor.
 *
 * Returns the {@link LoadedAggregate} so the caller can pass `revision`
 * into the next `save` and assert no concurrent writer slipped in.
 *
 * Failure modes:
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
): Effect.Effect<LoadedAggregate<Booking>, DomainError, BookingEventSourcedRepository> =>
  Effect.gen(function* () {
    const repo = yield* BookingEventSourcedRepository
    const id = yield* repo.findByKey(code)
    const loaded = yield* repo.load(id)
    if (loaded.state.phoneLast4 !== phoneLast4) {
      return yield* Effect.fail(new PhoneMismatchError({}))
    }
    return loaded
  })
