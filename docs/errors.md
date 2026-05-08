# Domain error catalogue

Phase 0.7-β2: every `DomainError` class has exactly one i18n key, one
GraphQL `__typename`, one stable `code`, one severity, and one audit
projection. The `derivations.ts` helpers are the single source — this
table mirrors them for human readers (the canonical mapping lives in
`packages/core/src/domain/errors/Errors.ts` and `derivations.ts`).

## Validation errors (boundary parse failures)

| `_tag` | code | i18n key | severity |
|---|---|---|---|
| `InvalidPhoneLast4` | `E_VAL_PHONE_LAST4` | `error.InvalidPhoneLast4` | validation |
| `InvalidNameKana` | `E_VAL_NAME_KANA` | `error.InvalidNameKana` | validation |
| `InvalidBookingCode` | `E_VAL_BOOKING_CODE` | `error.InvalidBookingCode` | validation |
| `InvalidFreeText` | `E_VAL_FREE_TEXT` | `error.InvalidFreeText` | validation |
| `InvalidDuration` | `E_VAL_DURATION` | `error.InvalidDuration` | validation |
| `InvalidHoldingDays` | `E_VAL_HOLDING_DAYS` | `error.InvalidHoldingDays` | validation |
| `InvalidTimeSlot` | `E_VAL_TIME_SLOT` | `error.InvalidTimeSlot` | validation |
| `InvalidBitmap` | `E_VAL_BITMAP` | `error.InvalidBitmap` | validation |
| `InvalidSkill` | `E_VAL_SKILL` | `error.InvalidSkill` | validation |
| `InvalidResourceType` | `E_VAL_RESOURCE_TYPE` | `error.InvalidResourceType` | validation |
| `InvalidWeekday` | `E_VAL_WEEKDAY` | `error.InvalidWeekday` | validation |
| `InvalidOpenWindow` | `E_VAL_OPEN_WINDOW` | `error.InvalidOpenWindow` | validation |
| `InvalidAbsence` | `E_VAL_ABSENCE` | `error.InvalidAbsence` | validation |
| `InvalidBusinessTimeZone` | `E_VAL_BUSINESS_TZ` | `error.InvalidBusinessTimeZone` | validation |
| `InvalidEntityId` | `E_VAL_ENTITY_ID` | `error.InvalidEntityId` | validation |

## Domain errors (business-rule violations)

| `_tag` | code | i18n key | severity |
|---|---|---|---|
| `BookingNotFound` | `E_DOM_BOOKING_NOT_FOUND` | `error.BookingNotFound` | domain |
| `PhoneMismatch` | `E_DOM_PHONE_MISMATCH` | `error.PhoneMismatch` | domain |
| `AlreadyCancelled` | `E_DOM_ALREADY_CANCELLED` | `error.AlreadyCancelled` | domain |
| `AlreadyCompleted` | `E_DOM_ALREADY_COMPLETED` | `error.AlreadyCompleted` | domain |
| `AlreadyNoShow` | `E_DOM_ALREADY_NO_SHOW` | `error.AlreadyNoShow` | domain |
| `SlotExpired` | `E_DOM_SLOT_EXPIRED` | `error.SlotExpired` | domain |
| `SlotUnavailable` | `E_DOM_SLOT_UNAVAILABLE` | `error.SlotUnavailable` | domain |
| `OutsideBusinessHours` | `E_DOM_OUTSIDE_HOURS` | `error.OutsideBusinessHours` | domain |
| `ServiceDisabled` | `E_DOM_SERVICE_DISABLED` | `error.ServiceDisabled` | domain |
| `ProviderUnavailable` | `E_DOM_PROVIDER_UNAVAILABLE` | `error.ProviderUnavailable` | domain |
| `ResourceUnavailable` | `E_DOM_RESOURCE_UNAVAILABLE` | `error.ResourceUnavailable` | domain |
| `InvalidStateTransition` | `E_DOM_INVALID_TRANSITION` | `error.InvalidStateTransition` | domain |
| `InsufficientCapability` | `E_DOM_INSUFFICIENT_CAPABILITY` | `error.InsufficientCapability` | domain |

## Infrastructure errors (storage / concurrency failures)

| `_tag` | code | i18n key | severity |
|---|---|---|---|
| `AggregateNotFound` | `E_INF_AGG_NOT_FOUND` | `error.AggregateNotFound` | infrastructure |
| `Concurrency` | `E_INF_CONCURRENCY` | `error.Concurrency` | infrastructure |
| `Storage` | `E_INF_STORAGE` | `error.Storage` | infrastructure |

## Four downstream surfaces

Every error in the table above is consumed by exactly four sinks; the
corresponding helper builds the wire shape for each:

| Sink | Helper | Phase that consumes it |
|---|---|---|
| Frontend i18n bundle | `errorToI18nKey(e)` | Phase 0.11 (paraglide-js) |
| GraphQL union arm | `errorToGraphQLPayload(e)` | Phase 0.7-β4 (Pothos errors plugin) |
| D1 audit_log row | `errorToAuditEntry(e, ctx)` | Phase 0.12 (D1AuditLoggerLive) |
| Worker structured log | `toLogPayload(e)` (in `Errors.ts`) | Phase 0.12 (WorkersLogger) |

Adding a new error class therefore touches exactly two files
(`Errors.ts` for the class, this table for the human contract); the
four sinks pick it up automatically.
