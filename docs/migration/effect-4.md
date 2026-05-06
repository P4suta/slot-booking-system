# Effect 4 + drizzle-orm 1.x migration plan (Phase 2.2)

## Status

**Deferred** — Phase 2.2 attempted in session 2026-05-06 but reverted.
Effect 4 is in **beta** (`4.0.0-beta.60`, no rc / no stable as of 2026-05),
and the migration surface measured **1224 type errors / 24 distinct
TS error codes / ~30 files** — Phase 2.0 redo + new feature in scope.
Bigger than fits in a regular session; needs a dedicated cycle.

The migration *should* still happen — `drizzle-orm@1.0.0-rc.2` is the
only path to `drizzle-orm/effect-schema` (the `createSelectSchema` /
`createInsertSchema` integration), which is the BI-10 enabler. But it
requires Effect 4 transitively (peer-dep `effect@>=4.0.0-beta.58`), so
the two ship together or not at all.

## Why drizzle-zod is not an acceptable fallback

`drizzle-zod` (`0.8.3`) is officially deprecated in favour of in-tree
schema generation (`drizzle-orm/zod`, `drizzle-orm/effect-schema`).
Bridging Zod → Effect Schema by hand re-introduces ad-hoc string
checks the BI-2 Schema-Derived Errors commit (`53899901`) explicitly
removed. Any use of `drizzle-zod` would be regression.

## Current pin (to revert to after upgrade)

```jsonc
// packages/core/package.json
"effect": "^3.21.0",

// apps/default/package.json
"drizzle-orm": "^0.45.0",
"drizzle-kit":  "^0.31.0",
"effect":       "^3.21.2",
```

## Target pin

```jsonc
"effect":      "^4.0.0",      // wait for stable, not beta.x
"drizzle-orm": "^1.0.0",
"drizzle-kit": "^1.0.0",
```

A safer alternative if 4.0 stable still lags — pin to a known-good
beta with a peer-dep escape hatch documented inline:

```jsonc
"effect":      "^4.0.0-beta.60",
"drizzle-orm": "^1.0.0-rc.2",
```

## Breaking changes inventory

Data-driven from `node_modules/.pnpm/effect@4.0.0-beta.60/.../dist/*.d.ts`
plus the upstream
[Schema migration guide](https://github.com/Effect-TS/effect-smol/blob/main/migration/schema.md).

### Context

| 3.21 form | 4.0 form |
|-----------|----------|
| `class C extends Context.Tag(key)<C, Shape>() {}` | `class C extends Context.Service<C, Shape>(key) {}` |
| `FiberRef.make(default)` | `Context.Reference<T>(key, { defaultValue: () => default })` |
| `Effect.locally(eff, ref, value)` | `Effect.provide(eff, Layer.succeed(ref, value))` (or new equivalent) |

Affected files (7 ports + runtime):

- `packages/core/src/application/ports/Clock.ts`
- `packages/core/src/application/ports/Logger.ts`
- `packages/core/src/application/ports/IdGenerator.ts`
- `packages/core/src/application/ports/AuditLogger.ts`
- `packages/core/src/application/ports/EventSourcedRepository.ts`
- `packages/core/src/application/ports/PiiPurger.ts`
- `packages/core/src/application/ports/ServiceCatalog.ts`
- `packages/core/src/application/runtime/TraceContext.ts` — `FiberRef`
  + `Effect.locally` replacement
- `packages/core/src/domain/errors/TraceId.ts` — if it touches FiberRef

### Schema

| 3.21 form | 4.0 form |
|-----------|----------|
| `Schema.TaggedError<Self>()(tag, fields)` | `Schema.TaggedErrorClass<Self>()(tag, fields)` |
| `Schema.Schema.Type<S>` | `Schema.Codec.Type<S>` |
| `Schema.Schema.Encoded<S>` | `Schema.Codec.Encoded<S>` |
| `Schema.Schema.Any` | (renamed — check Codec namespace) |
| `Schema.Literal("a", "b", "c")` | `Schema.Literals(["a", "b", "c"])` |
| `Schema.Union(A, B, C)` | `Schema.Union([A, B, C])` |
| `Schema.between(0, 1439)` | `Schema.isBetween({ minimum: 0, maximum: 1439 })` |
| `Schema.decodeUnknownEither(s)` | `Schema.decodeUnknownExit(s)` (Either-typed sync variant gone — `Exit`/`Result` is the closest) |
| `Schema.decodeSync` | unchanged |
| `Schema.encodeSync` | unchanged |
| `Schema.brand(B)` | unchanged signature, but `Bottom` typing is stricter — branded `Schema<...>` no longer matches generic `Schema<A>` constraints; use `Schema<A, I>` or `Schema.Schema.Any` style |
| `validate*` family | gone; use `decode*` + `toType` pattern |
| `filter()` | `check(makeFilter())` or `refine()` |
| `pick`/`omit` | `mapFields(Struct.pick/omit([...]))` |
| `partial` | `mapFields(Struct.map(Schema.optional))` |

Affected files (every Schema definition + all decoders/encoders):

- `packages/core/src/domain/errors/Errors.ts` — 25 `TaggedError` classes,
  3 `Schema.Literal` multi-arg → must become `Literals(...)`
- `packages/core/src/domain/errors/derivations.ts` — type-level
  `I18nKey` brand survives, body unchanged
- `packages/core/src/domain/errors/fromParseError.ts` — minor (uses
  `ParseResult.TreeFormatter.formatErrorSync` — confirm the API path)
- `packages/core/src/domain/booking/Booking.ts` — `Union` (variadic),
  `Literal` (single-arg, OK)
- `packages/core/src/domain/booking/Command.ts` — `Union` (variadic)
- `packages/core/src/domain/events/BookingEvent.ts` — `Union`
- `packages/core/src/domain/auth/Capability.ts` — `Union` + `Literal`
  multi-arg
- `packages/core/src/domain/types/EntityId.ts` — `transformOrFail`
  (verify Effect 4 signature)
- `packages/core/src/domain/types/Temporal.ts` — `transformOrFail`,
  `Schema.declare` (verify)
- `packages/core/src/domain/value-objects/*.ts` (10 files) — every
  brand pattern (`String.pipe(Schema.pattern, Schema.brand)`) needs
  re-typing per new `Bottom<>` constraint
- `packages/core/src/domain/entities/*.ts` (8 files) — mostly `Struct`
  (low risk) but `Weekday.ts` / `OpenWindow.ts` use refinements
  (verify)
- `packages/core/src/domain/slot/*.ts` — pure code, low risk
- `packages/core/src/application/schemas/HoldSlotRequest.ts` — full
  re-encode (`between`, `Schema.optional`, brand fields)
- `packages/core/src/application/usecases/*.ts` — `Effect.gen`
  yield pattern: 4.0 wants `yield* Effect.service(Tag)` (or class
  `Tag.use`), not bare `yield* Tag`. **Touches every use case.**
- `packages/core/src/derive/index.ts` — Schema → Arbitrary derivation
  (verify Effect 4 fast-check integration)
- `apps/default/src/server/auth/slotToken.ts` — `Schema.Struct` +
  `decodeUnknownEither` migration
- `apps/default/src/server/durableObjects/inputCodec.ts` — Phase 2.1
  Schema codec re-touch (`decodeUnknownSync`, `Codec.Encoded`)
- `apps/default/src/server/adapters/*.ts` (5 files) — Drizzle 1.x
  migration plus dependents on core Schema types
- `apps/default/src/server/graphql/builder.ts` + resolvers (5 files)
  — Pothos compatibility (see below)
- All `*.test.ts` (40+ files) — Effect.gen, Either, Schema usages

### Effect runtime

| 3.21 form | 4.0 form |
|-----------|----------|
| `yield* Tag` (in `Effect.gen`) | `yield* Effect.service(Tag)` or `yield* Tag.use((service) => Effect.succeed(...))` |
| `Either.match(e, { onLeft, onRight })` | survived, but `Either.isLeft / isRight` flow is preferred |
| Effect.gen iterator semantics | rewritten — `[Symbol.iterator]()` contract changed |
| `Effect.try` + `Effect.tryPromise` | survive, syntax unchanged |

The yield pattern change is the one that bites every use case. The
TS error code is **TS2488** ("must have a `[Symbol.iterator]()`
method").

### Drizzle 1.x

Confirmed compat (per
[release notes](https://github.com/drizzle-team/drizzle-orm/releases)):

- `select().from(table)` ✓
- `eq()`, `max()`, `sql\`...\`` ✓
- `insert(table).values(...).run()` ✓
- D1 / durable-sqlite drivers — no documented breaking changes

Breaking:

- `drizzle({ casing: "camel" })` → `snakeCase.table()` /
  `camelCase.table()` (we don't use it — no impact)
- Migration conflict detection requires `--ignore-conflicts` if
  multiple branches in the migration history
- Schema file extension whitelist enforced (`.ts` is OK)
- PostgreSQL `_query` removed (we don't use it)

### Pothos

**Open question** — `@pothos/core@4.12.0` and
`@pothos/plugin-errors@4.9.0` were tested against Effect 3.x. Effect 4
compatibility is **unverified**. The migration must include a Pothos
PoC step before committing to it: build `apps/default` after the core
Schema migration and confirm that `BookingError` / GraphQL union
arms still type-check.

If Pothos breaks, options are:

1. Hold migration until `@pothos/plugin-errors` ships an Effect-4
   build (track upstream)
2. Replace Pothos with a lighter-weight Effect-native GraphQL stack
   (Phase 2.8 territory — `@effect/rpc` would land here too)

## Recommended migration order

Each step ends in a tsc-green checkpoint. Don't move to the next
until tsc passes.

1. **Bump deps** (`effect`, `drizzle-orm`, `drizzle-kit`) — single
   commit.
2. **Schema sed-bulk renames** — `TaggedError` → `TaggedErrorClass`,
   `Schema.Type` → `Codec.Type`, `Schema.Encoded` → `Codec.Encoded`.
   Single bash one-liner.
3. **Schema variadic → array** — `Literal(a, b, c)` → `Literals([a, b, c])`,
   `Union(A, B, C)` → `Union([A, B, C])`. Hand-edit each call site
   (10–15 sites).
4. **Schema scalar API renames** — `between` → `isBetween` (single
   call site).
5. **Schema brand re-typing** — every value-object that does
   `Schema.String.pipe(Schema.brand(B))` may need a re-cast through
   `Schema.declare` or the new `refine` form.
6. **Context.Tag → Service** — 7 ports.
7. **Context.Reference for FiberRef** — `TraceContext.ts`.
8. **Effect.gen yield pattern** — every use case + every helper
   (`_authenticate`, `_applyAndPersist`, `_log`). The mechanical
   transform is `yield* Tag` → `yield* Effect.service(Tag)` (or class
   `.use((s) => ...)`). Tests too.
9. **decodeUnknownEither → decodeUnknownExit** — every parse-Either
   helper in value-objects.
10. **Pothos PoC** — build `apps/default`, surface every TS error.
    Decide on workaround if needed.
11. **drizzle-orm createSelectSchema integration (BI-10 proper)** —
    `apps/default/src/server/schema/*` → factor out per-entity
    `createSelectSchema(table)` → bridge to existing domain Schema in
    `D1ServiceCatalogLive` (the parametric factory takes a Schema; can
    we pass the drizzle-derived one directly, or do we still keep the
    domain Schema as the single source of truth?).
12. **Tests** — every `Effect.gen` test, every `decodeUnknownEither`
    test, every Schema arbitrary derivation.
13. **C1 100% / type-coverage 99.5% / lefthook all-green / size-limit**
    — final gates.

## Effort estimate

8–16 hours uninterrupted, with risk multipliers for:

- Pothos compatibility unknown (could be a 1–2-day blocker)
- `Effect.gen` yield pattern re-encoding across ~40 test files
- C1 100% maintenance (some helper Effects may need direct rewrite,
  not just a yield rename)
- Effect 4 still in beta — expect an API churn between beta.60 and
  the eventual 4.0.0 stable

## Decision criteria for restarting

Restart this migration when **any one** of:

- `effect@4.0.0` (stable) is published
- A `@pothos/plugin-errors` Effect-4-compatible release lands
- The team accepts the cost of a dedicated 2-day session

Until then, BI-10 stays carried over and Phase 2.3+ proceeds on
Effect 3.21 / drizzle 0.45.
