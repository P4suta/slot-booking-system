import { Effect, Layer, STM, TMap } from "effect"
import { BookingRepository } from "../../application/ports/BookingRepository.js"
import type { Booking } from "../../domain/booking/Booking.js"
import { BookingNotFoundError } from "../../domain/errors/Errors.js"
import type { BookingId } from "../../domain/types/EntityId.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"

/**
 * STM-backed in-memory {@link BookingRepository}.
 *
 * Two transactional maps cooperate: `byId` is the primary store and
 * `byCode` is the reverse-index used by self-service lookup. Upsert
 * commits both index updates inside one `STM` transaction so a code
 * lookup can never observe a half-written booking — there is no
 * window in which `byCode` knows the new booking but `byId` does not.
 *
 * STM (Software Transactional Memory) gives us:
 *   - lock-free, optimistic concurrency on the two indexes
 *   - automatic retry on rare write-write conflicts (none expected
 *     in tests, but the semantics are inherited for free if we ever
 *     parallelise the use-case test suites)
 *   - transactional composition: future use cases can `STM.flatMap`
 *     this implementation's STM primitives with their own (e.g.
 *     "find-then-upsert with version check" remains atomic)
 *
 * The `Effect`-shaped port methods are thin `STM.commit` wrappers, so
 * the public contract stays runtime-agnostic.
 */
export const makeInMemoryBookingRepository = (): Layer.Layer<BookingRepository> =>
  Layer.effect(
    BookingRepository,
    Effect.gen(function* () {
      const byId = yield* STM.commit(TMap.empty<BookingId, Booking>())
      const byCode = yield* STM.commit(TMap.empty<BookingCode, BookingId>())

      const findByIdSTM = (id: BookingId): STM.STM<Booking, BookingNotFoundError> =>
        STM.flatMap(TMap.get(byId, id), (opt) =>
          opt._tag === "Some" ? STM.succeed(opt.value) : STM.fail(new BookingNotFoundError({})),
        )

      const findByCodeSTM = (code: BookingCode): STM.STM<Booking, BookingNotFoundError> =>
        STM.flatMap(TMap.get(byCode, code), (idOpt) =>
          idOpt._tag === "Some" ? findByIdSTM(idOpt.value) : STM.fail(new BookingNotFoundError({})),
        )

      const upsertSTM = (b: Booking): STM.STM<void> =>
        STM.zipRight(TMap.set(byId, b.id, b), TMap.set(byCode, b.code, b.id))

      return BookingRepository.of({
        findById: (id) => STM.commit(findByIdSTM(id)),
        findByCode: (code) => STM.commit(findByCodeSTM(code)),
        upsert: (booking) => STM.commit(upsertSTM(booking)),
      })
    }),
  )

/** Convenience layer: a fresh, empty repository per test or per request. */
export const InMemoryBookingRepositoryLive = makeInMemoryBookingRepository()
