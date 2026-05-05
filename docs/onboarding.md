# Onboarding

Day-one notes for anyone (including future-you) joining the
`slot-booking-system` repository.

## Repo identity

- **slot-booking-system** is the home of:
  - `packages/core` — the industry-agnostic booking core (pure TS).
  - `apps/default` — a generic, deployable demo (placeholder Service /
    Provider / Resource names).
- The future **`bikeshop-booking`** repo is a separate codebase that
  will depend on `@booking/core` and replace `apps/default`'s
  configuration with bikeshop-specific deployment data. It does not
  live here.
- The user has authored **SYSTEM.md** (system-level contracts, lives
  in this repo) and **DEPLOYMENT.md** (bikeshop-specific deployment
  doc, lives in the future bikeshop repo). If you only see SYSTEM
  here, that is correct.

## Day-one setup

```sh
# Host needs only: docker, just, lefthook, mise (auto-installs the rest).
just bootstrap         # builds the dev image, installs deps, registers hooks
just sh                # interactive shell inside the dev container
```

## Daily commands (all run inside the dev container)

```sh
just typecheck         # tsc -b --pretty (Project References, incremental)
just lint              # biome check + eslint (type-aware) + markdownlint
just lint-eslint       # typescript-eslint strict-type-checked alone
just test              # vitest run, all packages
just test-coverage     # plus C1 branch coverage gate (100 % threshold)
just test-property     # fast-check property tests
just arch              # dependency-cruiser layer enforcement
just pii-guard         # ripgrep guard against PII keywords
just domain-purity     # ripgrep guard against industry-specific terms
just dead-code         # knip (unused exports / files / deps)
just type-coverage     # type-coverage --at-least 99.5 (no implicit any)
just attw              # arethetypeswrong (publish-shape sanity)
just check             # all of the above, the local CI mirror
just dev-default       # wrangler dev for apps/default (port 8787)
just bench             # vitest bench (computeAvailableSlots baseline)
just mutation          # Stryker (workflow_dispatch only; heavy)
```

The defence layers stack:

1. `tsc` strictest flags — `noUncheckedIndexedAccess`,
   `exactOptionalPropertyTypes`, `noImplicitOverride`,
   `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`.
2. **biome** — fast formatter + structural lints.
3. **typescript-eslint strict-type-checked** — type-aware lints
   (`no-floating-promises`, `switch-exhaustiveness-check`,
   `no-misused-promises`, `no-unsafe-*`, `no-deprecated`).
4. **ts-reset** — tightens stdlib types (`JSON.parse: unknown`,
   `array.filter(Boolean)` narrows, `Set.has(x)` narrows).
5. **branded types** via `Schema.brand(...)` — Rust-Newtype-style
   discrimination of every value-object and entity id.
6. **Effect.Schema** — runtime parse-don't-validate at every system
   boundary; the parser produces the type.
7. **type-coverage** — flags any drift toward `any` (≥ 99.5 % gate).
8. **arethetypeswrong** — publish-shape audit per package.
9. **knip** — unused exports / files / deps.
10. **dependency-cruiser** — layered import direction.
11. **vitest --coverage** — C1 100 % branch coverage on the pure
    domain.
12. **fast-check** — property tests on totals, idempotence, and
    state-machine commands (`fc.commands`).
13. **xstate** — declarative spec of the booking state graph,
    cross-validated against `apply` in tests.
14. **Stryker** — mutation testing (manual trigger; quarterly).

## Repository conventions

- All code reaches `main` through PRs. Commit messages follow
  Conventional Commits (`committed` checks them on `commit-msg`).
- New architecture decisions land as ADRs (`docs/adr/NNNN-…md`) with a
  row added to `docs/ADR_INDEX.md`. ADRs are not edited after merge —
  superseded instead.
- Memory-of-the-project lives in `~/.claude/projects/-…/memory/` for
  Claude Code sessions. The two anchored decisions are:
  - Smart algorithmic / data-structural solutions over naïve loops.
  - Everything inside Docker.
- Public industry-specific vocabulary (any term that names a business
  vertical) is forbidden in `packages/core` and `apps/default` — see
  ADR-0008 and the `domain-purity` guard.

## Where to look first when a question comes up

| Question                                  | Look in                                   |
| ----------------------------------------- | ----------------------------------------- |
| What does the system promise to users?    | `docs/SYSTEM.md`                          |
| Why does feature X look like this?        | `docs/adr/`                               |
| What term should I use?                   | `docs/glossary.md`                        |
| How do I run the thing?                   | This file + `Justfile`                    |
| What are we building next?                | The plan file in `~/.claude/plans/`. |

## Phase-0 finish line

You are at Phase 0 done when:

- `just check` is green from a clean clone in under 5 minutes.
- `packages/core` ships pure-domain code with C1 100 % branch coverage.
- ADR-0002 through ADR-0015 are present and indexed.
- `wrangler dev` starts in `apps/default` and answers a request.

Phase 1 begins after that mark and adds the customer-facing reservation
flow (HoldSlot / ConfirmBooking / CancelBooking / RescheduleBooking),
the DurableObject `DaySchedule`, and the SvelteKit pages.

## Phase-1 finish line

Phase 1 is done when:

- Use cases (`HoldSlot`, `ConfirmBooking`, `CancelBooking`,
  `RescheduleBooking`, `PurgeStalePii`) are implemented with full
  Layer composition and C1 100 % branch coverage.
- The `DaySchedule` Durable Object actor serializes per-day writes;
  `alarm()` expires stale holds and drains the outbox to D1
  (ADR-0027).
- Drizzle migration `0000_…sql` covers `bookings`,
  `booking_events`, `outbox`, `audit_log`.
- GraphQL endpoint at `/graphql` exposes:
  - **Query**: `availableSlots` (Phase 1 stub, Phase 2 wires the real
    catalog read).
  - **Mutation**: `holdSlot`, `confirmBooking`, `cancelBooking`,
    `rescheduleBooking` — all routed through the per-day DO.
- Cloudflare Workers `scheduled` cron at `0 4 * * *` runs the daily
  PII purge (NULLs `name_kana` / `phone_last4` / `free_text` on
  bookings whose terminal timestamp is more than 2 years old).
- Operational doc `docs/runbook.md` covers the seven on-call
  diagnostics paths.

Phase 2 picks up SvelteKit form actions (no-JS fallback), the
service-catalog read schema, and Cloudflare Access wiring for
admin-only mutations.
