import { Result, Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { schemaToArbitrary } from "../../src/derive/index.js"
import {
  BusinessHoursFromRow,
  ClosureFromRow,
  ProviderAbsenceFromRow,
  ProviderFromRow,
  ResourceFromRow,
  ServiceFromRow,
} from "../../src/infrastructure/schema/index.js"

/**
 * Phase 2.9 BI-10 SoT factor — lawful round-trip.
 *
 * The architectural claim made by `entityFromRow` is that the row
 * codec `R` and the domain codec `D` form a reflective subcategory
 * with `D` as the refinement layer. The retraction property is:
 *
 *   ∀ entity. decode(encode(entity)) ≡ entity         (round-trip)
 *
 * This file pins that claim per entity by deriving an Arbitrary from
 * the codec itself and asserting the round-trip preserves the entity
 * by structural equality (`Set` order is normalised inside the
 * encode overlay; Temporal values compare by `equals`).
 *
 * The Arbitrary-based property test catches drift between the row
 * codec, the overlay, and the domain Schema — the three sit in
 * `tables/`, `entityFromRow.ts`, and `domain/entities/` respectively,
 * and any one of them changing in isolation breaks the round-trip
 * before the table reaches D1.
 */

const lawfulRoundTrip = <Entity, RowEncoded>(
  label: string,
  codec: Schema.Codec<Entity, RowEncoded>,
  equiv: (a: Entity, b: Entity) => boolean,
) => {
  const arb = schemaToArbitrary(codec)
  const encode = Schema.encodeSync(codec)
  const decode = Schema.decodeUnknownResult(codec)

  it(`${label}: encode → decode round-trips`, () => {
    fc.assert(
      fc.property(arb, (entity) => {
        const round = decode(encode(entity))
        expect(Result.isSuccess(round)).toBe(true)
        if (Result.isSuccess(round)) {
          expect(equiv(round.success, entity)).toBe(true)
        }
      }),
      { numRuns: 30 },
    )
  })
}

const stringSetEq = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

describe("entityFromRow lawful round-trip — reflective subcategory retraction", () => {
  lawfulRoundTrip(
    "Service",
    ServiceFromRow,
    (a, b) =>
      a.id === b.id &&
      a.name === b.name &&
      a.description === b.description &&
      a.durationMinutes === b.durationMinutes &&
      a.bufferBeforeMinutes === b.bufferBeforeMinutes &&
      a.bufferAfterMinutes === b.bufferAfterMinutes &&
      a.holdingDays === b.holdingDays &&
      a.enabled === b.enabled &&
      stringSetEq(a.requiredSkills, b.requiredSkills) &&
      stringSetEq(a.requiredResourceTypes, b.requiredResourceTypes),
  )

  lawfulRoundTrip(
    "Provider",
    ProviderFromRow,
    (a, b) =>
      a.id === b.id &&
      a.name === b.name &&
      a.enabled === b.enabled &&
      stringSetEq(a.skills, b.skills),
  )

  lawfulRoundTrip(
    "Resource",
    ResourceFromRow,
    (a, b) => a.id === b.id && a.name === b.name && a.type === b.type && a.enabled === b.enabled,
  )

  lawfulRoundTrip(
    "Closure",
    ClosureFromRow,
    (a, b) => a.id === b.id && a.reason === b.reason && a.date.equals(b.date),
  )

  lawfulRoundTrip(
    "ProviderAbsence",
    ProviderAbsenceFromRow,
    (a, b) =>
      a.id === b.id &&
      a.providerId === b.providerId &&
      a.reason === b.reason &&
      a.start.equals(b.start) &&
      a.end.equals(b.end),
  )

  lawfulRoundTrip("BusinessHours", BusinessHoursFromRow, (a, b) => {
    if (a.id !== b.id || a.weekday !== b.weekday) return false
    if (a.windows.length !== b.windows.length) return false
    for (let i = 0; i < a.windows.length; i++) {
      const wa = a.windows[i]
      const wb = b.windows[i]
      if (wa === undefined || wb === undefined) return false
      if (!wa.start.equals(wb.start) || !wa.end.equals(wb.end)) return false
    }
    return true
  })
})
