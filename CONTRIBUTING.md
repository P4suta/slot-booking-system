# Contributing to slot-booking-system

Thank you for considering a contribution. The architecture decisions
this guide implements live in
[`docs/ADR_INDEX.md`](./docs/ADR_INDEX.md); the per-task walkthrough
is [`docs/dev-workflow.md`](./docs/dev-workflow.md).

## TL;DR

1. Open an issue or grab one from the tracker.
2. Branch off `main`. Use a descriptive slug
   (`feat/booking-confirmation-email`, `fix/outbox-retry-budget`).
3. Run `just bootstrap` once. Run `just check` before every push.
4. Land changes through pull requests. Squash-merge. Conventional
   Commits — see "Commit style" below.

## Architecture invariants

Three invariants gate every commit:

1. **Functional Core / Imperative Shell** (ADR-0018) — `packages/core`
   is pure (`Effect`-laden, no side effects in the source). Side
   effects live in adapter Live layers under `infrastructure/` or
   `apps/<deployment>/src/server/adapters/`. Enforced by
   `dependency-cruiser`.
2. **No PII in logs** (ADR-0009) — the regex grep gate
   `just pii-guard` rejects literal email / phone / address /
   birthday / gender field names in `packages/` and `apps/` (the
   audit log carries internal identifiers only). Enforced by
   lefthook pre-commit.
3. **Schema is the source of truth** (ADR-0036, ADR-0041) — every
   wire shape is derived from `Effect.Schema`; the printed SDL is
   compared byte-equal against `apps/default/schema.graphql`.
   Drift fails the pre-push gate.

If your change touches a layering boundary, an ADR is required (see
"Authoring an ADR" below).

## Day-1 discipline

- **TDD** — failing test first. Vitest + property tests via
  fast-check. The test file lives next to the source under
  `packages/core/test/` (or `apps/default/test/` for adapter-tier
  surfaces). Coverage threshold is C1 100 % aspirational; the
  current baseline is pinned in `vitest.config.ts` with a path
  back to 100 noted in the comment.
- **Branch coverage matters** — V8 line coverage hides the
  conditional inversions that branch coverage catches. Use
  property-based tests when the logic is non-trivial (e.g.,
  `BackoffPolicy.test.ts`).
- **Public docs follow the code** — adding a new `Schema.TaggedError`
  triggers `just gen-error-docs` (regenerates
  `docs/error-codes.md`) and an i18n catalogue update
  (`apps/web/messages/{ja,en}.json`). The drift gate fires if you
  forget.

## Lefthook gates (what runs on `git commit` / `git push`)

The full configuration is `lefthook.yml`. Pre-commit hooks (run on
the staged subset for speed):

- `typos` — spelling on text content.
- `domain-purity-staged` — `packages/core/src` cannot import
  `cloudflare:workers`, `wrangler`, or other deployment-specific
  packages.
- `pii-guard-staged` — see ADR-0009.
- `biome-staged` — formatter + linter pass over staged files.
- `committed` — Conventional Commits structure on the message.

Pre-push hook runs the `just check` mirror — typecheck, biome,
eslint, markdownlint, depcruise, vitest (apps/default + apps/web +
packages/core), coverage, knip, type-coverage, size-limit, schema
drift, error-doc drift.

## Commit style

Conventional Commits, capitalised subject (the `committed` hook
enforces both):

```text
Feat: Add staff cancellation use case

Cancellation by staff bypasses the customer credential check and
emits a `Cancelled` event with `SystemCapability` reason="staff".
The shared `applyAndPersist` helper covers the persistence path.

Test plan:
- packages/core/test/application/usecases/StaffCancelBooking.test.ts
- ADR-0007 invariant audit.

Co-Authored-By: <if applicable>
```

- Type prefixes: `Feat`, `Fix`, `Docs`, `Refactor`, `Test`,
  `Chore`, `Build`, `Ci`. Subject ≤ 50 chars (lefthook limit).
- The body is wrapped at 72 chars and is the primary surface for
  *why* — code already shows *what*. The "Test plan" footer is a
  promise to operators that the change is testable end-to-end.
- One topic per commit. The Phase 3 PR#8 commit train is the
  reference shape: each commit lands one independently-reviewable
  decision.

## Authoring an ADR

1. Copy `docs/adr/0000-template.md` to
   `docs/adr/NNNN-short-slug.md` with the next sequential number.
2. Fill the sections; keep paragraphs short and action-oriented.
3. Status starts as `proposed` if controversial, `accepted` if the
   call is clear at landing time.
4. Add a row to `docs/ADR_INDEX.md`.
5. Open a PR. Treat the ADR as a normal PR review — comments on the
   document file body are how alternatives surface.

## Recipe pointers

| If you want to … | Run |
|---|---|
| Bring up the dev stack | `just dev-up` |
| Smoke a booking end-to-end | `just smoke-all` |
| Trigger the cron handler | `just trigger-scheduled` |
| Fast-loop integration tests | `just test-integration` |
| Verify the pre-push pipeline | `just check` |
| Regenerate the error-tag doc | `just gen-error-docs` |
| Tail structured logs with jq | `just log-tail` |
| Run mutation tests (heavy) | `just mutation` |

The full recipe list is in [`Justfile`](./Justfile); the developer
walkthrough is [`docs/dev-workflow.md`](./docs/dev-workflow.md).

## Pull requests

- Branch off `main`, push, open a PR.
- Squash-merge by default. The PR title becomes the squashed commit
  message — write it as a Conventional Commit subject.
- CI must be green; reviewer approval required. The pre-push lefthook
  gate is the local mirror, so a green local push is generally a
  green CI run.

## Project memory

- [docs/SYSTEM.md](./docs/SYSTEM.md) — the iron principles the
  project is built on.
- [docs/ADR_INDEX.md](./docs/ADR_INDEX.md) — every architectural
  decision since Phase 0.
- [docs/error-codes.md](./docs/error-codes.md) — drift-gated tag
  table.
- [docs/observability.md](./docs/observability.md) — OTel + log +
  audit triple primer.
- [docs/runbook.md](./docs/runbook.md) — operational triage for the
  deployed system.

## License

Dual-licensed under Apache-2.0 OR MIT (the contributor's choice on
each contribution; the project repo distributes both). By opening a
PR you agree your contribution is dual-licensed under the same
terms.
