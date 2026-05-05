import { Effect, Either, Exit, type Schema } from "effect"
import { describe, expect, it } from "vitest"
import { BookingEventSourcedRepository } from "../../src/application/ports/EventSourcedRepository.js"
import type { Held } from "../../src/domain/booking/Booking.js"
import type { BookingEvent, HeldEventSchema } from "../../src/domain/events/BookingEvent.js"
import { newBookingEventId } from "../../src/domain/types/EntityId.js"
import {
  InMemoryEventSourcedBookingRepositoryLive,
  makeInMemoryEventSourcedHandle,
} from "../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"
import { baseHeld } from "../_fixtures/bookings.js"
import { at } from "../_fixtures/instants.js"

type HeldEvent = Schema.Schema.Type<typeof HeldEventSchema>

const heldEventOf = (b: Held): HeldEvent => ({
  id: newBookingEventId(),
  type: "Held",
  bookingId: b.id,
  at: b.heldAt,
  bookingCode: b.code,
  serviceId: b.serviceId,
  providerId: b.providerId,
  resourceIds: b.resourceIds,
  slot: b.slot,
})

/* The non-empty-array branding the port requires. */
const events1 = (b: Held): readonly [BookingEvent, ...BookingEvent[]] => [heldEventOf(b)]

const run = <A, E>(eff: Effect.Effect<A, E, BookingEventSourcedRepository>) =>
  Effect.runPromiseExit(eff.pipe(Effect.provide(InMemoryEventSourcedBookingRepositoryLive)))

describe("InMemoryEventSourcedBookingRepositoryLive", () => {
  describe("load", () => {
    it("fails with AggregateNotFound for an unknown id", async () => {
      const booking = baseHeld()
      const exit = await run(
        Effect.gen(function* () {
          const repo = yield* BookingEventSourcedRepository
          return yield* repo.load(booking.id)
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const cause = exit.cause
        // The fail tag should reach us as `AggregateNotFound`.
        const failure = JSON.stringify(cause)
        expect(failure).toContain("AggregateNotFound")
      }
    })

    it("returns the saved snapshot at revision = events.length after save", async () => {
      const booking = baseHeld()
      const exit = await run(
        Effect.gen(function* () {
          const repo = yield* BookingEventSourcedRepository
          yield* repo.save(booking.id, 0, events1(booking), booking)
          return yield* repo.load(booking.id)
        }),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.revision).toBe(1)
        expect(exit.value.state.id).toBe(booking.id)
        expect(exit.value.state.state).toBe("Held")
      }
    })
  })

  describe("save", () => {
    it("returns the new revision = expected + events.length", async () => {
      const booking = baseHeld()
      const exit = await run(
        Effect.gen(function* () {
          const repo = yield* BookingEventSourcedRepository
          return yield* repo.save(booking.id, 0, events1(booking), booking)
        }),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value.revision).toBe(1)
    })

    it("rejects with ConcurrencyError when expected revision does not match storage", async () => {
      const booking = baseHeld()
      const exit = await run(
        Effect.gen(function* () {
          const repo = yield* BookingEventSourcedRepository
          yield* repo.save(booking.id, 0, events1(booking), booking)
          // expected = 0, but storage is now at 1
          return yield* repo.save(booking.id, 0, events1(booking), booking)
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = JSON.stringify(exit.cause)
        expect(failure).toContain("Concurrency")
      }
    })

    it("appends successive events monotonically (rev advances by events.length each save)", async () => {
      const booking = baseHeld()
      const exit = await run(
        Effect.gen(function* () {
          const repo = yield* BookingEventSourcedRepository
          const r1 = yield* repo.save(booking.id, 0, events1(booking), booking)
          const r2 = yield* repo.save(booking.id, r1.revision, events1(booking), booking)
          const loaded = yield* repo.load(booking.id)
          return { r1: r1.revision, r2: r2.revision, loaded: loaded.revision }
        }),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toEqual({ r1: 1, r2: 2, loaded: 2 })
      }
    })
  })

  describe("findByKey", () => {
    it("returns the bookingId for a saved booking's code", async () => {
      const booking = baseHeld()
      const exit = await run(
        Effect.gen(function* () {
          const repo = yield* BookingEventSourcedRepository
          yield* repo.save(booking.id, 0, events1(booking), booking)
          return yield* repo.findByKey(booking.code)
        }),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe(booking.id)
    })

    it("fails with AggregateNotFound for an unknown code", async () => {
      const booking = baseHeld()
      const exit = await run(
        Effect.gen(function* () {
          const repo = yield* BookingEventSourcedRepository
          return yield* repo.findByKey(booking.code)
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = JSON.stringify(exit.cause)
        expect(failure).toContain("AggregateNotFound")
      }
    })
  })

  describe("layer instantiation", () => {
    it("each Layer.provide gives a fresh, empty store (no static-singleton bleed)", async () => {
      // Two separate runs of the same `Live` value must NOT see each
      // other's writes — Layer.effect's STM init runs per-runtime.
      const booking = baseHeld()
      const layerA = InMemoryEventSourcedBookingRepositoryLive
      const layerB = InMemoryEventSourcedBookingRepositoryLive

      const writeA = Effect.gen(function* () {
        const repo = yield* BookingEventSourcedRepository
        yield* repo.save(booking.id, 0, events1(booking), booking)
      })
      const readB = Effect.gen(function* () {
        const repo = yield* BookingEventSourcedRepository
        return yield* Effect.either(repo.load(booking.id))
      })

      await Effect.runPromise(writeA.pipe(Effect.provide(layerA)))
      const result = await Effect.runPromise(readB.pipe(Effect.provide(layerB)))

      expect(Either.isLeft(result)).toBe(true)
      // touch the fixture instant so vitest doesn't strip the import
      expect(at("2026-05-09T12:00:00Z").toString()).toMatch(/2026-05-09/)
    })
  })

  describe("makeInMemoryEventSourcedHandle (test inspection)", () => {
    it("exposes readEvents / readSnapshots that observe writes through the layer", async () => {
      const booking = baseHeld()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handle = yield* makeInMemoryEventSourcedHandle()
          const layered = Effect.gen(function* () {
            const repo = yield* BookingEventSourcedRepository
            yield* repo.save(booking.id, 0, events1(booking), booking)
            const loaded = yield* repo.load(booking.id)
            const id = yield* repo.findByKey(booking.code)
            return { loadedRev: loaded.revision, foundId: id }
          }).pipe(Effect.provide(handle.layer))
          const layered2 = yield* layered
          const events = yield* handle.readEvents
          const snapshots = yield* handle.readSnapshots
          return { events, snapshots, ...layered2 }
        }),
      )
      const eventLog = result.events.get(booking.id)
      expect(eventLog).toBeDefined()
      expect(eventLog?.length).toBe(1)
      expect(result.snapshots.get(booking.id)?.id).toBe(booking.id)
      expect(result.loadedRev).toBe(1)
      expect(result.foundId).toBe(booking.id)
    })

    it("starts empty (readEvents and readSnapshots are size-0 before any save)", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handle = yield* makeInMemoryEventSourcedHandle()
          const events = yield* handle.readEvents
          const snapshots = yield* handle.readSnapshots
          return { events, snapshots }
        }),
      )
      expect(result.events.size).toBe(0)
      expect(result.snapshots.size).toBe(0)
    })
  })
})
