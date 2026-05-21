# Onboarding

Day-one notes for anyone (including future-you) joining the
`slot-booking-system` repository.

## Repo identity

- **slot-booking-system** is the home of:
  - `packages/core` — the industry-agnostic queue core (pure TS).
    Domain entities are `Ticket` / `TicketEvent` / `QueueShop`; the
    customer takes a number, the staff calls the next in line.
  - `apps/default` — a generic, deployable demo (the queue runs on a
    single Cloudflare DurableObject, a WebSocket feed updates the
    public landing page in real time — ADR-0061).
- A downstream deployment (e.g. a future bikeshop / clinic / shop
  application) is a separate codebase that depends on `@booking/core`
  and replaces `apps/default`'s placeholder UI copy with the
  industry-specific surface. It does not live here.
- **SYSTEM.md** captures system-level contracts and lives in this
  repo; deployment-specific docs live with the consuming app.

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
just comment-bans      # historical-narrative token grep gate
just test              # vitest run, all packages
just test-coverage     # plus C1 branch coverage gate (100 % threshold)
just test-property     # fast-check property tests
just arch              # dependency-cruiser layer enforcement
just dead-code         # knip (unused exports / files / deps)
just type-coverage     # type-coverage --at-least 99.5 (no implicit any)
just attw              # arethetypeswrong (publish-shape sanity)
just check             # all of the above, the local CI mirror
just dev-default       # wrangler dev for apps/default (port 8787)
just bench             # vitest bench (replay / projection / transitions)
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
  ADR-0008. The historical-narrative grep gate (`just comment-bans`)
  enforces it from the comment side; review enforces it on the code
  side.

## Where to look first when a question comes up

| Question                                  | Look in                                   |
| ----------------------------------------- | ----------------------------------------- |
| What does the system promise to users?    | `docs/SYSTEM.md`                          |
| Why does feature X look like this?        | `docs/adr/`                               |
| What term should I use?                   | `docs/glossary.md`                        |
| How do I run the thing?                   | This file + `Justfile`                    |
| What are we building next?                | The plan file in `~/.claude/plans/`. |

## What runs end-to-end today

- `just check` is green from a clean clone.
- `packages/core` ships pure-domain queue code with high branch
  coverage; the 14 use cases (`IssueTicket`, `CheckIn`,
  `RescheduleTicket`, `CallNext`, `CallSpecific`, `CallBatch`,
  `Recall`, `Reorder`, `MarkServed`, `MarkNoShow`, `CancelTicket`,
  `MoveToOverdue`, `Nudge`, `LapseAppointment`) are exercised by
  unit + property tests. The last three are system-fired by the
  DO alarm sweep (ADR-0072 / ADR-0075).
- The `QueueShop` DurableObject (single instance,
  `idFromName("shop")`) serialises every state transition through
  `dispatch`. Its local SQLite holds the canonical event log
  (`ticket_events`), aggregate snapshots (every K=200 events),
  the read-side projection (`tickets`), the outbox queue, and the
  ticket-scoped Web Push subscription table (`push_subscriptions`,
  ADR-0073 / ADR-0074).
- The Hono router at `/api/v1/*` exposes the customer + staff
  surface (issue / recover-by-handle / cancel / reschedule /
  check-in / push-subscription / call-next / call-specific /
  call-batch / recall / reorder / served / no-show / staff login).
  Live projection updates push over a DO Hibernating WebSocket at
  `/api/v1/queue/feed` (ADR-0061). The error envelope is an
  exhaustive `Match.tagged` over `DomainError._tag`.
- Cloudflare Workers `scheduled` cron at `0 4 * * *` runs the daily
  PII purge over the D1 mirror (`name_kana`, `phone_last4`,
  `free_text` NULLed on terminal tickets > 2 years old).
- The SvelteKit frontend in `apps/web` reflects the queue state
  through the WebSocket feed for the public landing page and a
  staff-token-gated dashboard for the operator. Background
  notifications use Web Push (VAPID / aes128gcm) via the new
  `@booking/push` workspace package.

The architectural shape lands incrementally; ongoing ADR drafts
in `docs/adr/` capture follow-up decisions.
