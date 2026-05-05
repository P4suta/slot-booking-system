import { Duration, Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import type { DomainError } from "../../domain/errors/Errors.js"
import type { TraceId } from "../../domain/errors/TraceId.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import type { AvailableSlot } from "../../domain/slot/computeAvailableSlots.js"
import type { FreeText } from "../../domain/value-objects/FreeText.js"
import type { NameKana } from "../../domain/value-objects/NameKana.js"
import type { PhoneLast4 } from "../../domain/value-objects/PhoneLast4.js"
import { BookingCodeIndex } from "../ports/BookingCodeIndex.js"
import { BookingRepository } from "../ports/BookingRepository.js"
import { Clock } from "../ports/Clock.js"
import { EventStore } from "../ports/EventStore.js"
import { IdGenerator } from "../ports/IdGenerator.js"
import { Logger } from "../ports/Logger.js"
import { infoPayload } from "./_log.js"

/**
 * Place a 5-minute hold on a previously-listed available slot.
 *
 * **Capability discipline** — `slot: AvailableSlot` is a capability the
 * caller obtained from `computeAvailableSlots` (or its GraphQL surface).
 * Constructing an `AvailableSlot` outside that pure function requires
 * passing the same world snapshot (services, hours, providers, …),
 * which makes "hold a slot we never offered" essentially impossible at
 * the type / capability level — no double-check in the use case is
 * needed, and the DurableObject serialisation guarantees no concurrent
 * conflicting hold lands in the same window.
 *
 * **Phase pipeline** — read clock → mint ids → assemble Held + event →
 * persist (events are the source of truth, repository is the read-side
 * projection) → register the booking code in the bloom-filter index
 * (best-effort: a registry miss is recoverable, a registry forge is
 * not). All steps run inside a single `Effect.gen` so a failure at any
 * stage short-circuits without partial commit.
 */
export type HoldSlotInput = {
  readonly slot: AvailableSlot
  readonly nameKana: NameKana
  readonly phoneLast4: PhoneLast4
  readonly freeText: FreeText | null
  readonly source: Booking["source"]
  readonly traceId?: TraceId
}

export type HoldSlotResult = {
  readonly booking: Booking & { readonly state: "Held" }
  readonly event: BookingEvent & { readonly type: "Held" }
}

/** Hold lifetime — ADR-0005. After this, the DurableObject's `alarm` releases the hold. */
export const HOLD_TTL = Duration.minutes(5)

export const HoldSlot = (
  input: HoldSlotInput,
): Effect.Effect<
  HoldSlotResult,
  DomainError,
  Clock | IdGenerator | BookingRepository | EventStore | BookingCodeIndex | Logger
> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const idgen = yield* IdGenerator
    const repo = yield* BookingRepository
    const store = yield* EventStore
    const index = yield* BookingCodeIndex
    const logger = yield* Logger

    const now = yield* clock.nowInstant
    const expiresAt = now.add({ milliseconds: Duration.toMillis(HOLD_TTL) })
    const id = yield* idgen.newBookingId
    const code = yield* idgen.newBookingCode
    const eventId = yield* idgen.newBookingEventId

    const slotInstants = {
      start: input.slot.start.toInstant(),
      end: input.slot.end.toInstant(),
    }

    const booking = {
      id,
      code,
      serviceId: input.slot.serviceId,
      providerId: input.slot.providerId,
      resourceIds: input.slot.resourceIds,
      slot: slotInstants,
      source: input.source,
      nameKana: input.nameKana,
      phoneLast4: input.phoneLast4,
      freeText: input.freeText,
      state: "Held" as const,
      heldAt: now,
      expiresAt,
    }

    const event = {
      id: eventId,
      type: "Held" as const,
      bookingId: id,
      at: now,
      bookingCode: code,
      serviceId: input.slot.serviceId,
      providerId: input.slot.providerId,
      resourceIds: input.slot.resourceIds,
      slot: slotInstants,
    }

    // Append the event first — events are the source of truth (ADR-0024).
    yield* store.appendEvent(event)
    yield* repo.upsert(booking)
    yield* index.add(code)

    yield* logger.info(
      infoPayload("BookingHeld", "I_USECASE_HOLD_SLOT", { bookingId: id }, input.traceId),
    )

    return { booking, event }
  })
