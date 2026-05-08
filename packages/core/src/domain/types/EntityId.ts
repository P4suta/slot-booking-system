import { type Brand, Result, Schema } from "effect"
import { typeid } from "typeid-js"
import { type DomainError, InvalidEntityIdError } from "../errors/Errors.js"

/**
 * TypeID-shaped entity identifiers, branded so they cannot be
 * mistakenly substituted for one another (ADR-0003).
 *
 * Internal representation is the canonical TypeID string
 * `<prefix>_<ULID>`. Each id is materialised as an `Effect.Schema` so
 * the type, runtime decoder, and `Schema.is` predicate all derive
 * from a single declaration. The kind set is fixed by the
 * {@link ENTITY_KIND_TAG} map below — `Id<"tkt">` is `TicketId`,
 * `Id<"tev">` is `TicketEventId`, etc.
 */
const ENTITY_KIND_TAG = {
  tkt: "TicketId",
  tev: "TicketEventId",
  staf: "StaffId",
  audt: "AuditLogId",
  idem: "IdempotencyKeyId",
} as const satisfies Record<string, string>

/** Stable union of every TypeID prefix the system mints. */
export type EntityKind = keyof typeof ENTITY_KIND_TAG

type EntityTag<E extends EntityKind> = (typeof ENTITY_KIND_TAG)[E]

/**
 * Higher-kinded brand. `Id<"tkt">` ≡ `string & Brand<"TicketId">`.
 * Two distinct kinds yield mutually-disjoint branded types, even
 * though the runtime representation is plain `string` for both.
 */
export type Id<E extends EntityKind> = string & Brand.Brand<EntityTag<E>>

/** Tuple enumerating every {@link EntityKind}. Useful for property tests. */
export const ALL_ENTITY_KINDS = [
  "tkt",
  "tev",
  "staf",
  "audt",
  "idem",
] as const satisfies readonly EntityKind[]

/* -------------------------------------------------------------------------- */
/* Generic schema / parser / generator                                         */
/* -------------------------------------------------------------------------- */

const idSchema = <E extends EntityKind>(prefix: E) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^${prefix}_[0-9a-z]{26}$`))).pipe(
    Schema.brand(ENTITY_KIND_TAG[prefix]),
  )

/**
 * Result-flavoured parser for any {@link EntityKind}. Consumers use the
 * per-kind alias (`parseTicketId`, `parseStaffId`, …); the shared
 * generic exists so the kind table is the only place to register a new
 * id type.
 */
export const parseId =
  <E extends EntityKind>(prefix: E) =>
  (s: string): Result.Result<Id<E>, DomainError> => {
    const decoded = Schema.decodeUnknownResult(idSchema(prefix))(s)
    if (Result.isFailure(decoded)) {
      return Result.fail(new InvalidEntityIdError({ expectedPrefix: prefix, received: s }))
    }
    return Result.succeed(decoded.success as unknown as Id<E>)
  }

/**
 * Mint a fresh `Id<E>` for the given prefix using `typeid-js`. The
 * production runtime wires the IdGenerator port to this helper; tests
 * use a deterministic counter via `DeterministicIdGeneratorLive`.
 */
const newId =
  <E extends EntityKind>(prefix: E) =>
  (): Id<E> =>
    typeid(prefix).toString() as unknown as Id<E>

/* -------------------------------------------------------------------------- */
/* Per-kind aliases.                                                           */
/* -------------------------------------------------------------------------- */

export const TicketIdSchema = idSchema("tkt")
export type TicketId = Schema.Schema.Type<typeof TicketIdSchema>
export const parseTicketId = parseId("tkt")
export const newTicketId = newId("tkt")

export const TicketEventIdSchema = idSchema("tev")
export type TicketEventId = Schema.Schema.Type<typeof TicketEventIdSchema>
export const parseTicketEventId = parseId("tev")
export const newTicketEventId = newId("tev")

export const StaffIdSchema = idSchema("staf")
export type StaffId = Schema.Schema.Type<typeof StaffIdSchema>
export const parseStaffId = parseId("staf")
export const newStaffId = newId("staf")

export const AuditLogIdSchema = idSchema("audt")
export type AuditLogId = Schema.Schema.Type<typeof AuditLogIdSchema>
export const parseAuditLogId = parseId("audt")
export const newAuditLogId = newId("audt")

export const IdempotencyKeyIdSchema = idSchema("idem")
export type IdempotencyKeyId = Schema.Schema.Type<typeof IdempotencyKeyIdSchema>
export const parseIdempotencyKeyId = parseId("idem")
export const newIdempotencyKeyId = newId("idem")
