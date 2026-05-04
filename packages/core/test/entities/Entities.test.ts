import { Temporal } from "@js-temporal/polyfill"
import { Either } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { canonicalize, makeOpenWindow } from "../../src/domain/entities/OpenWindow.js"
import { providerSatisfies } from "../../src/domain/entities/Provider.js"
import { makeProviderAbsence } from "../../src/domain/entities/ProviderAbsence.js"
import { totalProviderMinutes } from "../../src/domain/entities/Service.js"
import { isWeekday, parseWeekday } from "../../src/domain/entities/Weekday.js"
import {
  newProviderAbsenceId,
  newProviderId,
  type ProviderId,
  type ServiceId,
} from "../../src/domain/types/EntityId.js"
import { minutesUnchecked } from "../../src/domain/value-objects/Duration.js"
import { parseHoldingDays } from "../../src/domain/value-objects/HoldingDays.js"
import { parseResourceType } from "../../src/domain/value-objects/ResourceType.js"
import { parseSkill, type Skill } from "../../src/domain/value-objects/Skill.js"

const skill = (s: string) => Either.getOrThrow(parseSkill(s))

describe("Skill", () => {
  it.each(["a", "general", "electric_assist", "skill_1"])("accepts %s", (s) =>
    expect(Either.isRight(parseSkill(s))).toBe(true))

  it.each([
    "",
    "1starts_with_digit",
    "Has-Hyphen",
    "Has Space",
    "TooLong" + "x".repeat(40),
  ])("rejects %s", (s) => expect(Either.isLeft(parseSkill(s))).toBe(true))
})

describe("ResourceType", () => {
  it.each(["workspace", "storage", "chair_a"])("accepts %s", (s) =>
    expect(Either.isRight(parseResourceType(s))).toBe(true))

  it.each(["", "1bad", "Workspace"])("rejects %s", (s) =>
    expect(Either.isLeft(parseResourceType(s))).toBe(true))
})

describe("Weekday", () => {
  it.each([1, 2, 3, 4, 5, 6, 7])("accepts %d", (n) =>
    expect(Either.isRight(parseWeekday(n))).toBe(true))

  it.each([0, 8, 1.5, -1])("rejects %p", (n) => expect(Either.isLeft(parseWeekday(n))).toBe(true))

  it("isWeekday narrows", () => {
    expect(isWeekday(3)).toBe(true)
    expect(isWeekday(0)).toBe(false)
  })
})

describe("OpenWindow", () => {
  const t = (h: number, m = 0) => Temporal.PlainTime.from({ hour: h, minute: m })

  it("rejects start ≥ end", () => {
    expect(Either.isLeft(makeOpenWindow(t(10), t(10)))).toBe(true)
    expect(Either.isLeft(makeOpenWindow(t(11), t(10)))).toBe(true)
  })

  it("accepts strict start < end", () => {
    expect(Either.isRight(makeOpenWindow(t(9), t(18)))).toBe(true)
  })

  it("canonicalize merges overlapping windows", () => {
    const w = (a: number, b: number) => Either.getOrThrow(makeOpenWindow(t(a), t(b)))
    const merged = canonicalize([w(13, 16), w(9, 12), w(11, 14)])
    expect(merged).toEqual([{ start: t(9), end: t(16) }])
  })

  it("canonicalize preserves disjoint windows in sorted order", () => {
    const w = (a: number, b: number) => Either.getOrThrow(makeOpenWindow(t(a), t(b)))
    const merged = canonicalize([w(13, 18), w(9, 12)])
    expect(merged).toEqual([
      { start: t(9), end: t(12) },
      { start: t(13), end: t(18) },
    ])
  })

  it("property: canonicalize is idempotent", () => {
    const t2 = (h: number) => Temporal.PlainTime.from({ hour: h })
    const arbWindow = fc
      .tuple(fc.integer({ min: 0, max: 22 }), fc.integer({ min: 1, max: 24 }))
      .filter(([a, b]) => a < b)
      .map(([a, b]) => ({ start: t2(a), end: t2(Math.min(b, 23)) }))
      .filter((w) => Temporal.PlainTime.compare(w.start, w.end) < 0)
    fc.assert(
      fc.property(fc.array(arbWindow, { maxLength: 8 }), (ws) => {
        const once = canonicalize(ws)
        const twice = canonicalize(once)
        return JSON.stringify(once) === JSON.stringify(twice)
      }),
    )
  })

  it("property: canonicalize output is non-overlapping and sorted", () => {
    const t2 = (h: number) => Temporal.PlainTime.from({ hour: h })
    const arbWindow = fc
      .tuple(fc.integer({ min: 0, max: 22 }), fc.integer({ min: 1, max: 23 }))
      .filter(([a, b]) => a < b)
      .map(([a, b]) => ({ start: t2(a), end: t2(b) }))
    fc.assert(
      fc.property(fc.array(arbWindow, { maxLength: 8 }), (ws) => {
        const out = canonicalize(ws)
        for (let i = 1; i < out.length; i++) {
          const prev = out[i - 1]
          const cur = out[i]
          if (!prev || !cur) return false
          if (Temporal.PlainTime.compare(prev.end, cur.start) > 0) return false
        }
        return true
      }),
    )
  })
})

describe("Service.totalProviderMinutes", () => {
  it("sums duration + buffers", () => {
    const id = "serv_test" as ServiceId
    expect(
      totalProviderMinutes({
        id,
        name: "x",
        description: "",
        durationMinutes: minutesUnchecked(60),
        bufferBeforeMinutes: minutesUnchecked(5),
        bufferAfterMinutes: minutesUnchecked(10),
        holdingDays: Either.getOrThrow(parseHoldingDays(0)),
        requiredSkills: new Set<Skill>(),
        requiredResourceTypes: new Set(),
        enabled: true,
      }),
    ).toBe(75)
  })
})

describe("Provider.providerSatisfies", () => {
  const sk = (s: string) => skill(s)

  it("true when provider has every required skill", () => {
    const p = {
      id: newProviderId(),
      name: "p",
      skills: new Set([sk("general"), sk("electric_assist")]),
      enabled: true,
    } as const
    expect(providerSatisfies(p, new Set([sk("general")]))).toBe(true)
    expect(providerSatisfies(p, new Set([sk("general"), sk("electric_assist")]))).toBe(true)
  })

  it("false when any required skill missing", () => {
    const p = {
      id: newProviderId(),
      name: "p",
      skills: new Set([sk("general")]),
      enabled: true,
    } as const
    expect(providerSatisfies(p, new Set([sk("electric_assist")]))).toBe(false)
  })

  it("true with empty required set (vacuously)", () => {
    const p = {
      id: newProviderId(),
      name: "p",
      skills: new Set<Skill>(),
      enabled: true,
    } as const
    expect(providerSatisfies(p, new Set())).toBe(true)
  })
})

describe("ProviderAbsence.makeProviderAbsence", () => {
  const at = (iso: string) => Temporal.Instant.from(iso)

  it("rejects start ≥ end", () => {
    const r = makeProviderAbsence({
      id: newProviderAbsenceId(),
      providerId: "prov_x" as ProviderId,
      start: at("2026-05-05T10:00:00Z"),
      end: at("2026-05-05T10:00:00Z"),
      reason: "test",
    })
    expect(Either.isLeft(r)).toBe(true)
  })

  it("accepts strict ordering", () => {
    const r = makeProviderAbsence({
      id: newProviderAbsenceId(),
      providerId: "prov_x" as ProviderId,
      start: at("2026-05-05T10:00:00Z"),
      end: at("2026-05-05T11:00:00Z"),
      reason: "test",
    })
    expect(Either.isRight(r)).toBe(true)
  })
})
