import {
  type BusinessHours,
  BusinessHoursSchema,
  type Closure,
  ClosureSchema,
  makeBusinessHours,
  makeProviderAbsence,
  type OpenWindow,
  type Provider,
  type ProviderAbsence,
  ProviderAbsenceSchema,
  ProviderSchema,
  parseWeekday,
  type Resource,
  ResourceSchema,
  type Service,
  ServiceSchema,
} from "@booking/core"
import { Temporal } from "@js-temporal/polyfill"
import { Either, Schema } from "effect"

/**
 * Catalog seed for `wrangler dev --local`.
 *
 * The seed is **not** a hand-written `.sql` file. Three reasons:
 *
 *   1. **Single source of truth** — entities are constructed through
 *      the same Effect Schemas the runtime decodes, so the row shape
 *      can never drift from the domain.
 *   2. **Deterministic ids** — every entity gets a stable, hard-coded
 *      TypeID. Re-running `just seed` is idempotent (the generated SQL
 *      uses `INSERT … ON CONFLICT (id) DO UPDATE`); operators can
 *      reference `serv_demo000000000000000000001` etc. across runs.
 *   3. **Industry-agnostic** — names live in copy strings, not in core
 *      vocabulary. The frontend can localise them; the slot search is
 *      pure mechanics on the metadata.
 *
 * Output is a single SQL document on stdout. `just seed` pipes it
 * through `wrangler d1 execute --local --file=…`. The values pass
 * `BusinessHoursSchema` / `ProviderAbsenceSchema` / etc. encoders, so
 * any drift between this file and the catalog Schemas surfaces as a
 * `decode` failure here, not as silent runtime corruption later.
 */

/* -------------------------------------------------------------------------- */
/* Stable test-fixture ids                                                     */
/* -------------------------------------------------------------------------- */

// 22-char fixed stem + 4-char zero-padded counter = 26 lowercase
// alphanumerics, satisfying `^${prefix}_[0-9a-z]{26}$` on every brand.
const STEM_22 = "demo000000000000000000"
const id = (prefix: string, n: number): string =>
  `${prefix}_${STEM_22}${String(n).padStart(4, "0")}`

const SERVICE_TRIM_ID = id("serv", 1)
const SERVICE_DEEP_ID = id("serv", 2)
const PROVIDER_ALICE_ID = id("prov", 1)
const PROVIDER_BOB_ID = id("prov", 2)
const RESOURCE_ROOM_A_ID = id("rsrc", 1)
const RESOURCE_ROOM_B_ID = id("rsrc", 2)

const fail = (reason: string): never => {
  process.stderr.write(`seed: ${reason}\n`)
  process.exit(1)
}

const expectRight = <A, E>(e: Either.Either<A, E>, reason: string): A =>
  Either.match(e, { onLeft: () => fail(`${reason}: ${JSON.stringify(e)}`), onRight: (v) => v })

/* -------------------------------------------------------------------------- */
/* Domain entities                                                             */
/* -------------------------------------------------------------------------- */

const services: readonly Service[] = (() => {
  const decode = Schema.decodeUnknownSync(ServiceSchema)
  return [
    decode({
      id: SERVICE_TRIM_ID,
      name: "30-minute consultation",
      description: "Short slot for first-time visitors.",
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 5,
      holdingDays: 0,
      requiredSkills: ["consultation"],
      requiredResourceTypes: ["meeting_room"],
      enabled: true,
    }),
    decode({
      id: SERVICE_DEEP_ID,
      name: "60-minute deep dive",
      description: "Hour-long working session.",
      durationMinutes: 60,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 10,
      holdingDays: 0,
      requiredSkills: ["consultation", "facilitation"],
      requiredResourceTypes: ["meeting_room"],
      enabled: true,
    }),
  ]
})()

const providers: readonly Provider[] = (() => {
  const decode = Schema.decodeUnknownSync(ProviderSchema)
  return [
    decode({
      id: PROVIDER_ALICE_ID,
      name: "Alice",
      skills: ["consultation", "facilitation"],
      enabled: true,
    }),
    decode({
      id: PROVIDER_BOB_ID,
      name: "Bob",
      skills: ["consultation"],
      enabled: true,
    }),
  ]
})()

const resources: readonly Resource[] = (() => {
  const decode = Schema.decodeUnknownSync(ResourceSchema)
  return [
    decode({
      id: RESOURCE_ROOM_A_ID,
      name: "Room A",
      type: "meeting_room",
      enabled: true,
    }),
    decode({
      id: RESOURCE_ROOM_B_ID,
      name: "Room B",
      type: "meeting_room",
      enabled: true,
    }),
  ]
})()

const businessHours: readonly BusinessHours[] = (() => {
  const window = (sH: number, eH: number): OpenWindow => ({
    start: Temporal.PlainTime.from({ hour: sH }),
    end: Temporal.PlainTime.from({ hour: eH }),
  })
  const decodeId = Schema.decodeUnknownSync(BusinessHoursSchema.fields.id)
  return [1, 2, 3, 4, 5].map((wd) =>
    makeBusinessHours(decodeId(id("bhrs", wd)), expectRight(parseWeekday(wd), "weekday"), [
      window(10, 13),
      window(14, 18),
    ]),
  )
})()

const closures: readonly Closure[] = (() => {
  const decode = Schema.decodeUnknownSync(ClosureSchema)
  return [
    decode({
      id: id("clos", 1),
      date: "2026-12-31",
      reason: "year-end",
    }),
  ]
})()

const providerAbsences: readonly ProviderAbsence[] = (() => {
  const decodeAbsenceId = Schema.decodeUnknownSync(ProviderAbsenceSchema.fields.id)
  const decodeProviderId = Schema.decodeUnknownSync(ProviderSchema.fields.id)
  const built = makeProviderAbsence({
    id: decodeAbsenceId(id("absn", 1)),
    providerId: decodeProviderId(PROVIDER_ALICE_ID),
    start: Temporal.Instant.from("2026-05-15T13:00:00Z"),
    end: Temporal.Instant.from("2026-05-15T17:00:00Z"),
    reason: "training",
  })
  return [expectRight(built, "provider-absence")]
})()

/* -------------------------------------------------------------------------- */
/* Render to SQL                                                               */
/* -------------------------------------------------------------------------- */

const sqlEscape = (raw: string): string => `'${raw.replace(/'/g, "''")}'`

const renderValue = (value: unknown): string => {
  if (value === null) return "NULL"
  if (typeof value === "boolean") return value ? "1" : "0"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return sqlEscape(value)
  return sqlEscape(JSON.stringify(value))
}

const upsertOne = <E, R>(table: string, schema: Schema.Schema<E, R>, entity: E): string => {
  const row = Schema.encodeSync(schema)(entity) as Record<string, unknown>
  const camelToSnake = (k: string): string => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
  const cols = Object.keys(row).map(camelToSnake)
  const vals = Object.keys(row).map((k) => renderValue(row[k]))
  const updateCols = cols.filter((c) => c !== "id")
  const updateAssignments = updateCols.map((c) => `${c}=excluded.${c}`)
  return [
    `INSERT INTO ${table} (${cols.join(", ")})`,
    `VALUES (${vals.join(", ")})`,
    `ON CONFLICT(id) DO UPDATE SET ${updateAssignments.join(", ")};`,
  ].join("\n")
}

const document: readonly string[] = [
  "-- Generated by apps/default/seed/seed.ts. Re-run `just seed` to refresh.",
  "-- Idempotent: each row uses INSERT ... ON CONFLICT(id) DO UPDATE SET ...",
  "",
  ...services.map((s) => upsertOne("services", ServiceSchema, s)),
  ...providers.map((p) => upsertOne("providers", ProviderSchema, p)),
  ...resources.map((r) => upsertOne("resources", ResourceSchema, r)),
  ...businessHours.map((bh) => upsertOne("business_hours", BusinessHoursSchema, bh)),
  ...closures.map((c) => upsertOne("closures", ClosureSchema, c)),
  ...providerAbsences.map((a) => upsertOne("provider_absences", ProviderAbsenceSchema, a)),
  "",
]

process.stdout.write(`${document.join("\n")}\n`)
