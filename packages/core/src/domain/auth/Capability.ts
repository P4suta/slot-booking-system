import { Match, Schema } from "effect"
import { StaffIdSchema } from "../types/EntityId.js"
import { BookingCodeFromUserInputSchema } from "../value-objects/BookingCode.js"
import { PhoneLast4Schema } from "../value-objects/PhoneLast4.js"
import * as ScopeSet from "./ScopeSet.js"
import { type StaffScope, StaffScopeSchema } from "./ScopeSet.js"

export { type StaffScope, StaffScopeSchema } from "./ScopeSet.js"

/**
 * Authorisation capability — the witness that a command-issuer has
 * permission to dispatch a particular command. A first-class value at
 * the domain layer (Phase 0.6 / ADR-0033 draft).
 *
 * Three variants, discriminated by `_tag`:
 *
 *   1. `CustomerCapability` — the booking-code + phone-last-4 pair the
 *      end user types into the self-service form. The bearer can act on
 *      *exactly one* booking (the one matching the credential pair).
 *      Verified by `_authenticate` against the repository.
 *
 *   2. `StaffCapability` — issued by the staff-side auth flow (Phase 1).
 *      Carries the operator's `StaffId` and a non-empty list of
 *      `StaffScope`s spelling out which transitions the operator may
 *      issue. `apply` rejects commands whose required scope is missing
 *      from the bearer's set.
 *
 *   3. `SystemCapability` — emitted by automated processes inside the
 *      Worker itself: `expire` from the DO alarm when a hold's TTL has
 *      elapsed; `purge` from the scheduled PII purge cron. Cannot be
 *      faked from outside the cluster (no external surface produces it).
 *
 * Replaces the old `by: "customer" | "staff" | "system"` string literal
 * (`Cancelled.cancelledBy`, `NoShow.markedBy`). Replacement is type-
 * driven: each `*Command` schema accepts only the capability subset that
 * may issue it (`Complete` ⊆ Staff; `Expire` ⊆ System; `Cancel` ⊆ any).
 */

/**
 * Why a System capability was minted. Closed set — every new auto-issued
 * command must justify itself by adding a literal here, which forces an
 * ADR-style review.
 */
export const SystemReasonSchema = Schema.Literals(["expire", "purge"])
export type SystemReason = Schema.Schema.Type<typeof SystemReasonSchema>

export const CustomerCapabilitySchema = Schema.Struct({
  _tag: Schema.Literal("CustomerCapability"),
  bookingCode: BookingCodeFromUserInputSchema,
  phoneLast4: PhoneLast4Schema,
})
export type CustomerCapability = Schema.Schema.Type<typeof CustomerCapabilitySchema>

export const StaffCapabilitySchema = Schema.Struct({
  _tag: Schema.Literal("StaffCapability"),
  staffId: StaffIdSchema,
  scopes: Schema.NonEmptyArray(StaffScopeSchema),
})
export type StaffCapability = Schema.Schema.Type<typeof StaffCapabilitySchema>

export const SystemCapabilitySchema = Schema.Struct({
  _tag: Schema.Literal("SystemCapability"),
  reason: SystemReasonSchema,
})
export type SystemCapability = Schema.Schema.Type<typeof SystemCapabilitySchema>

/**
 * Top-level union. `Schema.Union` over `_tag`-discriminated structs
 * yields a discriminated decoder + encoder + total exhaustiveness in
 * `Match.value(...)` consumers.
 */
export const CapabilitySchema = Schema.Union([
  CustomerCapabilitySchema,
  StaffCapabilitySchema,
  SystemCapabilitySchema,
])
export type Capability = Schema.Schema.Type<typeof CapabilitySchema>

/**
 * Subject category, derived purely from `_tag` for log payloads / GraphQL
 * resolution. Replaces the legacy `"customer" | "staff" | "system"`
 * scalar — call sites that need the wire-shape can read this rather
 * than serialise the full capability (which carries credentials).
 */
export const subjectOf: (cap: Capability) => "customer" | "staff" | "system" =
  Match.type<Capability>().pipe(
    Match.discriminator("_tag")("CustomerCapability", () => "customer" as const),
    Match.discriminator("_tag")("StaffCapability", () => "staff" as const),
    Match.discriminator("_tag")("SystemCapability", () => "system" as const),
    Match.exhaustive,
  )

/**
 * Materialise a {@link StaffCapability}'s wire-shape `scopes` array into
 * a {@link ScopeSet} bitmap so callers can compose / query capabilities
 * via the semilattice's join + isSet primitives in `O(1)`.
 */
export const scopeSetOf = (cap: StaffCapability): ScopeSet.ScopeSet =>
  ScopeSet.fromScopes(cap.scopes)

/** Whether a staff capability includes the requested scope. */
export const hasScope = (cap: StaffCapability, scope: StaffScope): boolean =>
  ScopeSet.hasScope(scopeSetOf(cap), scope)
