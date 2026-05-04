# 0003. TypeID prefix registry

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: domain, ids

## Context

Internal entity identifiers must be (1) sortable by creation time, (2) globally unique, (3) self-describing in logs, (4) mutually distinguishable in TypeScript so a `BookingId` cannot be silently passed where a `ResourceId` is expected.

## Decision

Use [TypeID](https://github.com/jetify-com/typeid) (prefix + ULID) for every persistable entity. Prefixes are reserved per entity:

| Prefix  | Entity            | Notes                                |
| ------- | ----------------- | ------------------------------------ |
| `book_` | Booking           | Customer-facing surface uses `BookingCode`, not this id. |
| `serv_` | Service           |                                      |
| `prov_` | Provider          |                                      |
| `rsrc_` | Resource          | Workspace, storage rack, …           |
| `clos_` | Closure           | Holiday or one-off store closure.    |
| `absn_` | ProviderAbsence   | Irregular absence (≠ shift).         |
| `bhrs_` | BusinessHours     | One row per weekday.                 |
| `evnt_` | BookingEvent      | Append-only event log id.            |
| `audt_` | AuditLog          | Staff-action trail.                  |
| `idem_` | IdempotencyKey    | Stored in DO; not surfaced.          |

Each prefix maps 1:1 to a branded TypeScript type (`BookingId`, `ServiceId`, …). Cross-entity assignment is a compile error; `expect-type` enforces this with type-level tests.

## Consequences

- Logs are self-describing without a join table: `book_01h…` is unambiguously a booking.
- ULID time-ordering keeps D1 indexes hot at the tail.
- Adding a new entity is an ADR-bump plus one prefix entry; no DB migration just to allocate.

## Alternatives considered

- **UUIDv4**: random ordering hurts D1 page locality.
- **Per-entity sequential ints**: leak volume, are not globally unique, and fail in distributed creation.
- **ULID without prefix**: still globally unique but loses self-description in logs.

## References

- SYSTEM.md §4.5.3.
- TypeID spec.
