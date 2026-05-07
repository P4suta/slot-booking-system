import type { ResultOf, VariablesOf } from "gql.tada"
import { describe, expectTypeOf, it } from "vitest"
import type {
  AvailableSlotsQuery,
  CancelBookingMutation,
  ConfirmBookingMutation,
  HoldSlotMutation,
  ServicesQuery,
} from "../../src/lib/graphql/queries.js"

/**
 * Phase 3 PR#8 / commit 13 — type-level pin for the gql.tada-generated
 * types behind the SvelteKit pages. `gql.tada` infers
 * `ResultOf<typeof Query>` / `VariablesOf<typeof Query>` from the
 * `graphql(...)` literal text checked against `src/graphql-env.d.ts`,
 * which is regenerated from `apps/default/schema.graphql` on every
 * `pnpm run codegen`. A drift between the worker schema and the
 * client query catalogue lands here as a `tsc` failure rather than as
 * a runtime "field X does not exist on …".
 *
 * The assertions deliberately cover the **discriminated union** arms
 * (`MutationHoldSlotResult` = `MutationHoldSlotSuccess | BookingError`)
 * because the Svelte page narrows on `__typename` — losing the
 * `BookingError` arm would silently break every error-render path.
 */
describe("apps/web gql.tada typegen drift", () => {
  it("AvailableSlotsQuery yields the expected slot fields", () => {
    type Result = ResultOf<typeof AvailableSlotsQuery>
    type Slot = NonNullable<NonNullable<Result["availableSlots"]>[number]>
    expectTypeOf<Slot>().toExtend<{
      readonly serviceId: string
      readonly start: string
      readonly end: string
      readonly providerId: string
      readonly resourceIds: readonly string[]
      readonly token: string
    }>()
    expectTypeOf<VariablesOf<typeof AvailableSlotsQuery>>().toExtend<{
      readonly serviceId: string
      readonly date: string
    }>()
  })

  it("ServicesQuery yields the expected service fields including the enabled flag", () => {
    type Result = ResultOf<typeof ServicesQuery>
    type Service = NonNullable<NonNullable<Result["services"]>[number]>
    expectTypeOf<Service>().toExtend<{
      readonly id: string
      readonly name: string
      readonly description: string | null
      readonly durationMinutes: number
      readonly enabled: boolean
    }>()
  })

  it("HoldSlotMutation result is a discriminated union over Success | BookingError", () => {
    type Result = NonNullable<ResultOf<typeof HoldSlotMutation>["holdSlot"]>
    type SuccessArm = Extract<Result, { __typename: "MutationHoldSlotSuccess" }>
    type ErrorArm = Extract<Result, { __typename: "BookingError" }>
    expectTypeOf<SuccessArm["data"]>().toExtend<{
      readonly bookingId: string
      readonly state: string
      readonly eventType: string
    }>()
    expectTypeOf<ErrorArm>().toExtend<{
      readonly tag: string
      readonly code: string
      readonly i18nKey: string
      readonly message: string
    }>()
  })

  it("ConfirmBookingMutation result narrows the same Success | BookingError union", () => {
    type Result = NonNullable<ResultOf<typeof ConfirmBookingMutation>["confirmBooking"]>
    type Success = Extract<Result, { __typename: "MutationConfirmBookingSuccess" }>
    type Err = Extract<Result, { __typename: "BookingError" }>
    expectTypeOf<Success>().not.toBeNever()
    expectTypeOf<Err>().not.toBeNever()
  })

  it("CancelBookingMutation requires the reason variable (not an optional)", () => {
    type Vars = VariablesOf<typeof CancelBookingMutation>
    expectTypeOf<Vars>().toExtend<{
      readonly date: string
      readonly code: string
      readonly phoneLast4: string
      readonly reason: string
    }>()
  })
})
