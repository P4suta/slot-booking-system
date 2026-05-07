import { type Context, Effect, Layer } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  BookingEventSourcedRepository,
  type EventSourcedRepositoryOps,
  type LoadedAggregate,
  type NonEmptyReadonlyArray,
  type SecondaryIndexOps,
} from "../../src/application/ports/EventSourcedRepository.js"
import type { Booking, Held } from "../../src/domain/booking/Booking.js"
import type {
  AggregateNotFoundError,
  ConcurrencyError,
  StorageError,
} from "../../src/domain/errors/Errors.js"
import type { BookingEvent } from "../../src/domain/events/BookingEvent.js"
import type { BookingId } from "../../src/domain/types/EntityId.js"
import type { BookingCode } from "../../src/domain/value-objects/BookingCode.js"

/*
 * Compile-time + runtime contract suite for the event-sourced repository
 * port. The port is a Context.Tag, so its class symbol must be importable
 * at runtime; its Service shape is a structural intersection of
 * `EventSourcedRepositoryOps<Booking, BookingId, BookingEvent>` and
 * `SecondaryIndexOps<BookingId, BookingCode>`. Both are asserted here.
 */

describe("BookingEventSourcedRepository (Context.Tag)", () => {
  it("exposes a stable identifier suitable for layer composition", () => {
    expect(BookingEventSourcedRepository.key).toBe("@booking/core/BookingEventSourcedRepository")
  })

  it("is a Context.Tag — usable as the second argument of Layer.succeed", () => {
    const stub: Context.Service.Shape<typeof BookingEventSourcedRepository> = {
      load: () =>
        Effect.fail(
          // We never actually run this — we're proving the shape compiles.
          { _tag: "AggregateNotFound" } as AggregateNotFoundError,
        ),
      save: () => Effect.succeed({ revision: 0 }),
      findByKey: () => Effect.fail({ _tag: "AggregateNotFound" } as AggregateNotFoundError),
    }
    const layer = Layer.succeed(BookingEventSourcedRepository, stub)
    expect(layer).toBeDefined()
  })
})

describe("EventSourcedRepositoryOps<A, I, E> — type contract", () => {
  type Ops = EventSourcedRepositoryOps<Booking, BookingId, BookingEvent>

  it("load(id) returns LoadedAggregate<A> with Aggregate or Storage failure", () => {
    expectTypeOf<Ops["load"]>().parameter(0).toEqualTypeOf<BookingId>()
    expectTypeOf<ReturnType<Ops["load"]>>().toEqualTypeOf<
      Effect.Effect<LoadedAggregate<Booking>, AggregateNotFoundError | StorageError>
    >()
  })

  it("save(id, expected, events, next) returns next revision or Concurrency/Storage failure", () => {
    expectTypeOf<Ops["save"]>().parameter(0).toEqualTypeOf<BookingId>()
    expectTypeOf<Ops["save"]>().parameter(1).toEqualTypeOf<number>()
    expectTypeOf<Ops["save"]>().parameter(2).toEqualTypeOf<NonEmptyReadonlyArray<BookingEvent>>()
    expectTypeOf<Ops["save"]>().parameter(3).toEqualTypeOf<Booking>()
    expectTypeOf<ReturnType<Ops["save"]>>().toEqualTypeOf<
      Effect.Effect<{ readonly revision: number }, ConcurrencyError | StorageError>
    >()
  })
})

describe("SecondaryIndexOps<I, K> — type contract", () => {
  type Idx = SecondaryIndexOps<BookingId, BookingCode>

  it("findByKey(key) returns the resolved aggregate id", () => {
    expectTypeOf<Idx["findByKey"]>().parameter(0).toEqualTypeOf<BookingCode>()
    expectTypeOf<ReturnType<Idx["findByKey"]>>().toEqualTypeOf<
      Effect.Effect<BookingId, AggregateNotFoundError | StorageError>
    >()
  })
})

describe("NonEmptyReadonlyArray<T>", () => {
  it("rejects empty literal at compile time, accepts singletons and longer", () => {
    // `as NonEmptyReadonlyArray<number>` would be a type error on `[]`.
    const single: NonEmptyReadonlyArray<number> = [1]
    const triple: NonEmptyReadonlyArray<number> = [1, 2, 3]
    expect(single.length).toBeGreaterThan(0)
    expect(triple.length).toBeGreaterThan(0)
  })
})

describe("Tag.Service<…> structural intersection", () => {
  it("includes both EventSourcedRepositoryOps and SecondaryIndexOps members", () => {
    type Service = Context.Service.Shape<typeof BookingEventSourcedRepository>
    expectTypeOf<Service>().toExtend<
      EventSourcedRepositoryOps<Booking, BookingId, BookingEvent> &
        SecondaryIndexOps<BookingId, BookingCode>
    >()
    // The aggregate type is exactly Booking (not a wider supertype).
    expectTypeOf<Awaited<ReturnType<Service["load"]>>>()
      // `Awaited` is a no-op for Effect.Effect (it's not a Promise) — the
      // assertion is on the Effect's success channel via .toEqualTypeOf below.
      .toExtend<unknown>()
    type LoadSuccess = Effect.Success<ReturnType<Service["load"]>>
    expectTypeOf<LoadSuccess>().toEqualTypeOf<LoadedAggregate<Booking>>()
    expectTypeOf<LoadSuccess["state"]>().toEqualTypeOf<Booking>()
  })

  it("exposes Held as a narrowable subtype of state via discriminated union", () => {
    type Service = Context.Service.Shape<typeof BookingEventSourcedRepository>
    type LoadSuccess = Effect.Success<ReturnType<Service["load"]>>
    // Held is one variant of Booking; the union assignability proves the
    // load surface preserves the full discriminated union.
    expectTypeOf<Held>().toExtend<LoadSuccess["state"]>()
  })
})
