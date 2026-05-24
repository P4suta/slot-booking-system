/**
 * ADR-0085 drift detector — domain `TicketSchema` ↔ `WireTicketSchema`.
 *
 * `responseSchemas.ts` carries a hand-written Effect Schema mirror
 * of the domain `Ticket` discriminated union (one flat-collapsed
 * struct). Hand-writing is intentional: it dodges a
 * `Schema.toJsonSchemaDocument` structural-dedup bug that fires
 * when the same `Instant` ref reappears across several fields of
 * one schema (see `responseSchemas.ts` header). The cost of the
 * duplication is drift risk — this test catches that risk by
 * round-tripping every variant: domain fixture → `Schema.encode`
 * → JSON.parse → `WireTicketSchema.decode`. If the wire schema
 * loses a field a domain variant emits, decode fails.
 *
 * Updating a domain variant means updating both the fixture below
 * (TS strictness flags the diff) and `responseSchemas.ts` if a new
 * field surfaces. The fixtures are deliberately wide (every field
 * a variant carries) so a missing-field regression in
 * `responseSchemas.ts` triggers a decode failure rather than
 * silently accepting a narrower wire shape.
 */
import {
  type Called,
  type Cancelled,
  InstantSchema,
  type NoShow,
  type Overdue,
  type Served,
  TicketSchema,
  type Waiting,
} from "@booking/core"
import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { WireTicketSchema } from "../../../src/server/http/responseSchemas.js"

const instant = (iso: string) => Schema.decodeUnknownSync(InstantSchema)(iso)

const T0 = instant("2026-05-24T09:00:00.000Z")
const T1 = instant("2026-05-24T09:15:00.000Z")
const T2 = instant("2026-05-24T09:30:00.000Z")
const T3 = instant("2026-05-24T09:45:00.000Z")

const ID = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^tkt_[0-9a-z]{26}$/)))(
  "tkt_01h5a1234567890123456789ab",
) as unknown as Waiting["id"]

const KANA = Schema.decodeUnknownSync(
  // NameKana → NFKC + collapse + trim, satisfied by a plain kana string
  Schema.String,
)("アイウエオ") as unknown as Waiting["nameKana"]

const P4 = "1234" as unknown as Waiting["phoneLast4"]
const FREE = null as Waiting["freeText"]

const common = {
  id: ID,
  seq: 1,
  lane: "walkIn" as const,
  displaySeq: 7,
  nameKana: KANA,
  phoneLast4: P4,
  freeText: FREE,
  issuedAt: T0,
  appointmentAt: null,
  checkedInAt: null,
}

const waitingFixture: Waiting = { ...common, state: "Waiting" }

const calledFixture: Called = {
  ...common,
  state: "Called",
  calledAt: T1,
  calledBy: "staff",
}

const overdueFixture: Overdue = {
  ...common,
  state: "Overdue",
  calledAt: T1,
  calledBy: "staff",
  overdueAt: T2,
  lastNudgedAt: null,
  nudgeCount: 0,
}

const servedFixture: Served = {
  ...common,
  state: "Served",
  calledAt: T1,
  calledBy: "staff",
  servedAt: T2,
  servedBy: "staff",
}

const noShowFixture: NoShow = {
  ...common,
  state: "NoShow",
  calledAt: T1,
  calledBy: "staff",
  markedAt: T2,
  markedBy: "system",
}

const cancelledFixture: Cancelled = {
  ...common,
  state: "Cancelled",
  cancelledAt: T3,
  cancelledBy: "customer",
  reason: "schedule conflict",
}

const cases: readonly { name: string; fixture: unknown }[] = [
  { name: "Waiting", fixture: waitingFixture },
  { name: "Called", fixture: calledFixture },
  { name: "Overdue", fixture: overdueFixture },
  { name: "Served", fixture: servedFixture },
  { name: "NoShow", fixture: noShowFixture },
  { name: "Cancelled", fixture: cancelledFixture },
]

describe("ADR-0085 — domain Ticket ↔ WireTicket drift", () => {
  for (const { name, fixture } of cases) {
    it(`${name} fixture round-trips through encode → JSON → WireTicket decode`, () => {
      // 1. Encode the domain fixture through the union schema —
      //    this turns `Temporal.Instant` fields into ISO strings.
      const encoded = Schema.encodeUnknownSync(TicketSchema)(fixture)
      // 2. Serialise to JSON and back so the test exercises the
      //    actual wire shape the customer / staff client observes.
      const wireForm = JSON.parse(JSON.stringify(encoded))
      // 3. The wire form must decode through WireTicketSchema with
      //    no loss; a missing optional field on a state-specific
      //    arm is the canonical drift signal.
      const wireCheck = Schema.decodeUnknownResult(WireTicketSchema)(wireForm)
      if (!Result.isSuccess(wireCheck)) {
        throw new Error(
          `WireTicketSchema rejected the ${name} wire form: ${JSON.stringify(wireCheck, null, 2)}`,
        )
      }
      expect(Result.isSuccess(wireCheck)).toBe(true)
    })
  }
})
