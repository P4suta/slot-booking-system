# queue-pivot 修正の現状 (broken state inventory)

> 14 commit で queue pivot を land、 その後の DX 強化フェーズで
> `just diagnose` を整備した時点の **baseline snapshot**。 修正 phase
> (Phase G) の根拠。

## baseline (HEAD `40d5a01`、 Phase A-C 完了直後)

`just diagnose-tsc` 出力より:

### typecheck — 57 errors

#### top files

| file | errors |
|------|-------:|
| `packages/core/test/application/usecases/queue/Lifecycle.test.ts` | 23 |
| `apps/default/src/server/adapters/D1AuditLoggerLive.ts` | 6 |
| `packages/core/src/domain/value-objects/CustomerHandle.ts` | 5 |
| `apps/default/src/server/durableObjects/QueueShop.ts` | 5 |
| `packages/core/src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.ts` | 4 |
| `apps/default/src/server/adapters/DurableObjectTicketRepositoryLive.ts` | 3 |
| `packages/core/test/domain/auth/Capability.test.ts` | 2 |
| `packages/core/src/domain/types/EntityId.ts` | 2 |
| `packages/core/src/application/usecases/queue/CallNext.ts` | 2 |
| `apps/default/src/server/api/queue.ts` | 2 |

#### top error codes

| TS#### | count | 推定意味 |
|--------|------:|----------|
| TS2379 | 12 | exactOptionalPropertyTypes covariance (主に Effect / Result の widening) |
| TS2339 | 8 | Property does not exist (`Effect.catchAll` / `Effect.either` / `entry.action` 等の API 不在) |
| TS18046 | 8 | `r is of type 'unknown'` — `Effect.either` 不在の連鎖で結果型が unknown |
| TS2345 | 7 | Argument of type X not assignable (Effect/Result type mismatch) |
| TS2375 | 5 | exactOptionalPropertyTypes (Result の error param widening) |
| TS2558 | 3 | Expected 1 type arguments, but got 2 (`Result.fail<A,E>` の API 縮約) |
| TS2352 | 3 | `as { code: string }` 等の型 cast not overlapping |
| TS7006 | 2 | implicit any |
| TS2322 | 2 | Type X not assignable to Y |
| TS18048 | 2 | Object possibly undefined (noUncheckedIndexedAccess) |

#### top (file × error code) pairs

| file | error | count |
|------|-------|------:|
| Lifecycle.test.ts | TS2379 | 10 |
| Lifecycle.test.ts | TS18046 | 8 |
| Lifecycle.test.ts | TS2339 | 4 |
| InMemoryEventSourcedRepositoryLive.ts | TS2345 | 4 |
| CustomerHandle.ts | TS2558 | 3 |
| D1AuditLoggerLive.ts | TS2339 | 3 |
| CustomerHandle.ts | TS2375 | 2 |
| api/queue.ts | TS2352 | 2 |
| DurableObjectTicketRepositoryLive.ts | TS18048 | 2 |
| EntityId.test.ts | TS2379 | 1 |

### biome — PASS (0 violations)

queue pivot 中の auto-fix で format は揃っている。

### arch — FAIL (3 no-orphans)

| source | violation |
|--------|-----------|
| `packages/core/src/domain/typeclass/Satisfier.ts` | no-orphans |
| `packages/core/src/domain/typeclass/Identifiable.ts` | no-orphans |
| `apps/default/src/server/graphql/derive.ts` | no-orphans |

Phase 0 で consumer (`booking/transitions.ts`、 `staffCatalog.ts` 等) を
削除した結果、 typeclass 配下の helper と graphql/derive.ts が孤立。 Phase
3 で REST + SSE に置換した際に derive.ts が consumer 0 に。 修正方針 (Phase G):

- `domain/typeclass/{Satisfier, Identifiable}.ts` — Phase 1.2 の
  Ticket/event 構築でも未使用、 削除候補
- `graphql/derive.ts` — Phase 3 で REST + SSE に切り替えたので未使用。
  Phase 7 で GraphQL 復活する場合に備えて残すか、 削除してアーカイブから
  復活させるか方針判断。 暫定: **削除** (将来 GraphQL を復活させるなら ADR
  起票 + 復活 commit で)

### eslint / test — Phase H 時に再走 (現時点未測定)

## 修正計画 — Phase G の cluster 構成

`just diagnose-tsc` の (file × error code) pair から、 1 commit で複数
errors を消せる cluster を抽出:

### G1 — Effect 4 API 差 (推定 16 errors を解消)

- `Effect.catchAll` 不在 → `Effect.catch` (export alias)
- `Effect.either` 不在 → `Effect.match` または `Effect.runPromiseExit`
- `Result.fail<A,E>` の型引数 1 個に縮約

影響 file:
- `apps/default/src/server/adapters/D1AuditLoggerLive.ts` (TS2339 × 3)
- `apps/default/src/server/durableObjects/QueueShop.ts` (TS2339 + TS7006 含む 5)
- `packages/core/src/domain/value-objects/CustomerHandle.ts` (TS2558 × 3)
- `packages/core/test/application/usecases/queue/Lifecycle.test.ts` (TS18046 × 8 + TS2339 × 4)
- `packages/core/src/application/usecases/queue/CallNext.ts` (TS2375 × 2)
- `packages/core/src/application/usecases/queue/IssueTicket.ts` (TS2375 × 1)

### G2 — AuditLogger / AuditEntry shape (推定 6 errors)

- `AuditLogger.write(entry)` (`record` でない)
- `AuditEntry = {ts, actor, outcome, errorTag, errorCode, traceId?}`

影響 file: `D1AuditLoggerLive.ts` 全体

### G3 — Result widening / Effect widening (推定 12 errors)

- smart constructor 内 `Result.fail<DomainError>` で widen
- `Effect<A, E1, R> → Effect<A, E1 | E2, R>` の明示

影響 file:
- `CustomerHandle.ts` (TS2375 × 2)
- `EntityId.ts` (TS2375 + TS2352)
- `CallNext.ts` / `IssueTicket.ts` の Effect 戻り値

### G4 — noUncheckedIndexedAccess (推定 2 errors)

- `rows[0].revision` を `rows[0]?.revision ?? 0` or 早期 length check

影響 file:
- `DurableObjectTicketRepositoryLive.ts` (TS18048 × 2)

### G5 — DurableObject override modifier (推定 1 error)

- `alarm()` に `override`

影響 file: `QueueShop.ts`

### G6 — ScopeSet narrowing + cast 除去 (推定 3 errors)

- `new Set<StaffScope>()` 明示
- `api/queue.ts` の `(handleR.failure as { code: string }).code` を
  `codeOf(handleR.failure)` 経由に

影響 file: `ScopeSet.ts` (TS2345 × 1)、 `api/queue.ts` (TS2352 × 2)

### G7 — test 群 (Lifecycle / Capability / EntityId test)

- `Effect.either` 不在の書き直し (`Effect.runPromiseExit` + `Exit.match`)
- `Result<A, never>` widening を関数 signature の型注釈で pin
- `Schema.decodeUnknownResult` の type narrowing

影響 file:
- `Lifecycle.test.ts` (23 errors のうち G1-G3 で 16 解消後、 残 7)
- `Capability.test.ts` (TS2345 × 1 + TS2322 × 1)
- `EntityId.test.ts` (TS2379 × 1)

### G8 — orphan removal / seed.ts cleanup (arch 3 + apps/default の Phase 1
seed broken import)

- `domain/typeclass/{Satisfier, Identifiable}.ts` 削除
- `apps/default/src/server/graphql/derive.ts` 削除
- `apps/default/seed/seed.ts` 削除 (queue pivot 後の生成 seed が必要なら別 ADR)

## 進捗ログ (Phase G で追記)

| commit | gate | before | after | delta |
|--------|------|-------:|------:|------:|
| baseline `40d5a01` | typecheck | — | 57 | — |
| baseline `40d5a01` | arch | — | 3 | — |
| (Phase G commits land here) | | | | |
