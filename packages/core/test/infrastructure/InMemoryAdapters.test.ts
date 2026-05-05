import { Temporal } from "@js-temporal/polyfill"
import { Effect, Either, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { BookingRepository } from "../../src/application/ports/BookingRepository.js"
import { EventStore } from "../../src/application/ports/EventStore.js"
import { Logger } from "../../src/application/ports/Logger.js"
import type { BookingEvent } from "../../src/domain/events/BookingEvent.js"
import { newBookingEventId, newBookingId } from "../../src/domain/types/EntityId.js"
import type { BookingCode } from "../../src/domain/value-objects/BookingCode.js"
import {
  InMemoryEventStoreLive,
  makeInMemoryEventStoreWithReader,
} from "../../src/infrastructure/eventstore/InMemoryEventStoreLive.js"
import {
  makeSilentLogger,
  SilentLoggerLive,
} from "../../src/infrastructure/logger/SilentLoggerLive.js"
import { InMemoryBookingRepositoryLive } from "../../src/infrastructure/repository/InMemoryBookingRepositoryLive.js"
import { bookingCode } from "../_fixtures/parsers.js"

describe("InMemoryBookingRepositoryLive", () => {
  it("findByCode rejects an unknown code with BookingNotFound", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* BookingRepository
      return yield* Effect.either(repo.findByCode(bookingCode(999n)))
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(InMemoryBookingRepositoryLive)))
    expect(Either.isLeft(r)).toBe(true)
    if (Either.isLeft(r)) expect(r.left._tag).toBe("BookingNotFound")
  })

  it("findById on a missing id rejects with BookingNotFound", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* BookingRepository
      return yield* Effect.either(repo.findById(newBookingId()))
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(InMemoryBookingRepositoryLive)))
    expect(Either.isLeft(r)).toBe(true)
  })
})

describe("InMemoryEventStoreLive", () => {
  const sampleEvent = (): BookingEvent => ({
    id: newBookingEventId(),
    type: "Confirmed",
    bookingId: newBookingId(),
    at: Temporal.Instant.from("2026-05-09T01:00:00Z"),
  })

  it("convenience layer accepts appendEvent", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore
      yield* store.appendEvent(sampleEvent())
    })
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStoreLive)))
  })

  it("makeInMemoryEventStoreWithReader exposes the layer + a snapshot reader sharing one log", async () => {
    const program = Effect.gen(function* () {
      const handle = yield* makeInMemoryEventStoreWithReader()
      const event = sampleEvent()
      yield* Effect.gen(function* () {
        const store = yield* EventStore
        yield* store.appendEvent(event)
      }).pipe(Effect.provide(handle.layer))
      const snapshot = yield* handle.readAll
      return { event, snapshot }
    })
    const out = await Effect.runPromise(program)
    const events = out.snapshot.get(out.event.bookingId)
    expect(events).toBeDefined()
    expect(events?.length).toBe(1)
    expect(events?.[0]?.id).toBe(out.event.id)
  })

  it("appending multiple events to the same booking preserves order", async () => {
    const bookingId = newBookingId()
    const e1: BookingEvent = {
      id: newBookingEventId(),
      type: "Confirmed",
      bookingId,
      at: Temporal.Instant.from("2026-05-09T01:00:00Z"),
    }
    const e2: BookingEvent = {
      id: newBookingEventId(),
      type: "Cancelled",
      bookingId,
      at: Temporal.Instant.from("2026-05-09T02:00:00Z"),
      reason: "x",
      by: "customer",
    }
    const program = Effect.gen(function* () {
      const handle = yield* makeInMemoryEventStoreWithReader()
      yield* Effect.gen(function* () {
        const store = yield* EventStore
        yield* store.appendEvent(e1)
        yield* store.appendEvent(e2)
      }).pipe(Effect.provide(handle.layer))
      return yield* handle.readAll
    })
    const snapshot = await Effect.runPromise(program)
    const events = snapshot.get(bookingId)
    expect(events?.map((e) => e.id)).toEqual([e1.id, e2.id])
  })
})

describe("SilentLoggerLive", () => {
  const samplePayload = {
    _tag: "BookingHeld" as const,
    code: "I_TEST",
    severity: "domain" as const,
    data: { bookingId: "book_x" },
  }

  it("convenience SilentLoggerLive accepts info/warn/error and drops them", async () => {
    const program = Effect.gen(function* () {
      const log = yield* Logger
      yield* log.info(samplePayload)
      yield* log.warn(samplePayload)
      yield* log.error(samplePayload)
    })
    await Effect.runPromise(program.pipe(Effect.provide(SilentLoggerLive)))
  })

  it("makeSilentLogger retains every emitted entry with its level", async () => {
    const program = Effect.gen(function* () {
      const handle = yield* makeSilentLogger()
      yield* Effect.gen(function* () {
        const log = yield* Logger
        yield* log.info(samplePayload)
        yield* log.warn({ ...samplePayload, code: "I_TEST_WARN" })
        yield* log.error({ ...samplePayload, code: "I_TEST_ERR" })
      }).pipe(Effect.provide(handle.layer))
      return yield* handle.emitted
    })
    const emitted = await Effect.runPromise(program)
    expect(emitted.map((e) => e.level)).toEqual(["info", "warn", "error"])
    expect(emitted[0]?.payload.code).toBe("I_TEST")
    expect(emitted[1]?.payload.code).toBe("I_TEST_WARN")
    expect(emitted[2]?.payload.code).toBe("I_TEST_ERR")
  })
})

// Ensure the TS-typed import dance is genuinely exercised at compile time.
const _typeProbe: Layer.Layer<BookingRepository | EventStore | Logger> = Layer.mergeAll(
  InMemoryBookingRepositoryLive,
  InMemoryEventStoreLive,
  SilentLoggerLive,
)
void _typeProbe
void newBookingId
void (null as unknown as BookingCode)
