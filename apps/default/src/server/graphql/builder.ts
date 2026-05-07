import type { BookingSource } from "@booking/core"
import SchemaBuilder from "@pothos/core"
import ErrorsPlugin from "@pothos/plugin-errors"
import { GraphQLError } from "graphql"
import type { DaySchedule } from "../durableObjects/DaySchedule.js"
import { BookingError } from "./errors.js"

/**
 * Pothos GraphQL schema builder.
 *
 * **Context shape** — every resolver gets `{ env, request }` so it can:
 *   - reach the per-day DurableObject via typed RPC method invocation
 *     (`env.DAY_SCHEDULE.get(id).holdSlot(input)` etc.); the DO is the
 *     actor that serialises mutations within a single day (ADR-0005)
 *   - reach D1 directly (`env.DB`) for the long-retention read
 *     projections (ADR-0006)
 *
 * The `DurableObjectNamespace<DaySchedule>` typing pulls the RPC
 * method signatures through to the resolver — `stub.holdSlot(input)`
 * etc. type-check end-to-end without any cast (ADR-0030).
 *
 * **Custom scalars** validate at the GraphQL boundary so the types
 * threaded into use cases are already narrowed (`PlainDate`, `Instant`
 * arrive as ISO-8601 strings; `PhoneLast4` arrives as four digits).
 * The same Effect Schema parsers run downstream inside the use cases,
 * but failing fast at the GraphQL parser keeps the error responses
 * uniform.
 *
 * **Errors plugin (Phase 0.7-β4)** — `@pothos/plugin-errors` is
 * registered with `BookingError` as the default thrown type. Resolvers
 * declare `errors: { types: [BookingError] }` and `throw new
 * BookingError(payload)` instead of `throw new GraphQLError(...)`;
 * the plugin emits a typed GraphQL union `<Result> | BookingError`
 * for each field, so the client narrows on `__typename` rather than
 * inspecting the legacy `errors[]` blob.
 */
export type GraphQLContext = {
  readonly env: {
    readonly DB: D1Database
    readonly DAY_SCHEDULE: DurableObjectNamespace<DaySchedule>
    readonly DEPLOYMENT_TIMEZONE: string
    readonly SLOT_HMAC_SECRET: string
  }
  readonly request: Request
}

export const builder = new SchemaBuilder<{
  Scalars: {
    PlainDate: { Input: string; Output: string }
    Instant: { Input: string; Output: string }
    PhoneLast4: { Input: string; Output: string }
  }
  Context: GraphQLContext
}>({
  plugins: [ErrorsPlugin],
  errors: {
    defaultTypes: [BookingError],
  },
})

const expectString =
  (typeName: string) =>
  (v: unknown): string => {
    if (typeof v !== "string") {
      throw new GraphQLError(`${typeName} must be a JSON string`)
    }
    return v
  }

// Pothos 4.x requires the Query root to be declared explicitly before
// `queryFields(...)` can attach to it. Resolvers in this directory
// add their fields through `queryFields` / `mutationFields`; the two
// roots themselves are registered here so the builder has the bare
// types ready at side-effect-import time.
builder.queryType({})

builder.scalarType("PlainDate", {
  description: "ISO-8601 calendar date (e.g. 2026-05-05).",
  serialize: (v) => v,
  parseValue: expectString("PlainDate"),
})

builder.scalarType("Instant", {
  description: "ISO-8601 instant in UTC (e.g. 2026-05-05T09:30:00Z).",
  serialize: (v) => v,
  parseValue: expectString("Instant"),
})

builder.scalarType("PhoneLast4", {
  description: "Last four digits of a phone number — exactly four ASCII digits.",
  serialize: (v) => v,
  parseValue: expectString("PhoneLast4"),
})

/**
 * GraphQL enum that mirrors the domain `BookingSource` literal union
 * (`@booking/core`). Declaring it here lets resolver `args.source` carry
 * the narrowed type at the call site without a runtime cast — the
 * GraphQL parser refuses any value that is not one of the four
 * literals.
 */
export const BookingSourceEnum = builder.enumType("BookingSource", {
  description: "Origin of a booking — distinguishes self-service from operator-entered.",
  values: {
    online: { value: "online" satisfies BookingSource },
    walkin: { value: "walkin" satisfies BookingSource },
    phone: { value: "phone" satisfies BookingSource },
    staff: { value: "staff" satisfies BookingSource },
  } as const,
})

builder.objectType(BookingError, {
  name: "BookingError",
  description:
    "A booking operation refused by the domain. Carries the discriminator tag, " +
    "stable error code, severity, and an i18n key the frontend can localize.",
  fields: (t) => ({
    tag: t.exposeString("tag"),
    code: t.exposeString("code"),
    severity: t.exposeString("severity"),
    i18nKey: t.exposeString("i18nKey"),
    message: t.exposeString("message"),
  }),
})
