import type { DaySchedule } from "../durableObjects/DaySchedule.js"

/**
 * Per-request context every GraphQL resolver receives. The Worker
 * `fetch` handler builds this once per request and threads it through
 * yoga so resolvers can:
 *
 *   - reach the per-day DurableObject via typed RPC method invocation
 *     (`env.DAY_SCHEDULE.get(id).holdSlot(input)` etc.); the DO is
 *     the actor that serialises mutations within a single day
 *     (ADR-0005)
 *   - reach D1 directly (`env.DB`) for the long-retention read
 *     projections (ADR-0006)
 *   - access deployment-level configuration: the IANA time zone the
 *     business runs in (`DEPLOYMENT_TIMEZONE`) and the HMAC secret
 *     that signs `AvailableSlot` tokens (`SLOT_HMAC_SECRET`)
 *
 * The `DurableObjectNamespace<DaySchedule>` typing pulls the RPC
 * method signatures through to the resolver — `stub.holdSlot(input)`
 * etc. type-check end-to-end without any cast (ADR-0030).
 */
export type GraphQLContext = {
  readonly env: {
    readonly DB: D1Database
    readonly DAY_SCHEDULE: DurableObjectNamespace<DaySchedule>
    readonly DEPLOYMENT_TIMEZONE: string
    readonly SLOT_HMAC_SECRET: string
  }
  readonly request: Request
  /**
   * Pre-resolved cause redactor for the active {@link RuntimeMode}.
   * Yoga's `useDevErrorExtensions` plugin spreads its return value
   * into `result.errors[].extensions`. The pre-resolution happens
   * once per request inside the context factory so the plugin stays
   * synchronous (no `Effect.runSync` inside `onExecuteDone`).
   */
  readonly redactCause: (cause: unknown) => Record<string, unknown>
}
