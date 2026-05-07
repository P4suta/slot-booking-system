import { describe, expect, it } from "vitest"
import { tablesToDDL, tableToDDL } from "../../src/server/durableObjects/ddl.js"
import { bookingEvents } from "../../src/server/schema/bookingEvents.js"
import { bookings } from "../../src/server/schema/bookings.js"
import { outbox, outboxDead } from "../../src/server/schema/outbox.js"

describe("tablesToDDL", () => {
  it("renders a CREATE TABLE for bookings", () => {
    const stmts = tableToDDL(bookings)
    expect(stmts.length).toBeGreaterThanOrEqual(1)
    const create = stmts[0] ?? ""
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS bookings \(/)
    expect(create).toContain("id text NOT NULL PRIMARY KEY")
    expect(create).toContain("code text NOT NULL UNIQUE")
    expect(create).toContain("state text NOT NULL")
    expect(create).toContain("name_kana text")
    expect(create).toContain("updated_at text NOT NULL DEFAULT")
  })

  it("renders booking_events with the unique index on (booking_id, seq)", () => {
    const stmts = tableToDDL(bookingEvents)
    expect(stmts.length).toBeGreaterThanOrEqual(2)
    const create = stmts[0] ?? ""
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS booking_events \(/)
    expect(create).toContain("id text NOT NULL PRIMARY KEY")
    expect(create).toContain("seq integer NOT NULL")
    const idx = stmts.find((s) => s.startsWith("CREATE UNIQUE INDEX")) ?? ""
    expect(idx).toContain("ux_booking_events_booking_seq")
    expect(idx).toContain("(booking_id, seq)")
  })

  it("renders outbox with the next_attempt_at index", () => {
    const stmts = tableToDDL(outbox)
    expect(stmts[0] ?? "").toMatch(/^CREATE TABLE IF NOT EXISTS outbox \(/)
    const idx = stmts.find((s) => s.includes("ix_outbox_next_attempt")) ?? ""
    expect(idx).toContain("(next_attempt_at)")
  })

  it("renders outbox_dead", () => {
    const stmts = tableToDDL(outboxDead)
    expect(stmts[0] ?? "").toMatch(/^CREATE TABLE IF NOT EXISTS outbox_dead \(/)
  })

  it("tablesToDDL flattens DDL across tables", () => {
    const all = tablesToDDL([bookings, bookingEvents, outbox, outboxDead])
    expect(all.some((s) => s.includes("CREATE TABLE IF NOT EXISTS bookings"))).toBe(true)
    expect(all.some((s) => s.includes("CREATE TABLE IF NOT EXISTS booking_events"))).toBe(true)
    expect(all.some((s) => s.includes("CREATE TABLE IF NOT EXISTS outbox"))).toBe(true)
    expect(all.some((s) => s.includes("CREATE TABLE IF NOT EXISTS outbox_dead"))).toBe(true)
  })
})
