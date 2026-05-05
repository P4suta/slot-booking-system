import { builder } from "../builder.js"

/**
 * `availableSlots` query — Phase 0.5 stub. Returns an empty array
 * unconditionally so the toolchain end-to-end (Pothos → Yoga → Worker
 * → curl) is exercised without dragging in the full Phase 1 wiring
 * (BookingRepository over D1, Service catalog, etc.).
 *
 * The shape mirrors `domain/slot/computeAvailableSlots.ts`'s
 * `AvailableSlot` so once Phase 1 plugs in the real resolver, only the
 * body changes — the schema stays stable.
 */

type AvailableSlotShape = {
  readonly start: string
  readonly end: string
  readonly providerId: string
  readonly resourceIds: readonly string[]
}

const AvailableSlotType = builder.objectRef<AvailableSlotShape>("AvailableSlot").implement({
  description: "A bookable time interval with a tentative provider/resources assignment.",
  fields: (t) => ({
    start: t.field({ type: "Instant", resolve: (s) => s.start }),
    end: t.field({ type: "Instant", resolve: (s) => s.end }),
    providerId: t.exposeString("providerId"),
    resourceIds: t.exposeStringList("resourceIds"),
  }),
})

builder.queryType({
  fields: (t) => ({
    availableSlots: t.field({
      type: [AvailableSlotType],
      description: "Bookable slots for a service on a given date. Phase 0.5 stub: always empty.",
      args: {
        serviceId: t.arg.string({ required: true }),
        date: t.arg({ type: "PlainDate", required: true }),
      },
      resolve: (): AvailableSlotShape[] => [],
    }),
  }),
})
