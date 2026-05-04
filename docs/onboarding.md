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
just typecheck         # pnpm -r exec tsc --noEmit
just lint              # biome check + markdownlint
just test              # vitest run, all packages
just test-coverage     # plus C1 branch coverage gate
just test-property     # fast-check property tests
just arch              # dependency-cruiser layer enforcement
just pii-guard         # ripgrep guard against PII keywords
just domain-purity     # ripgrep guard against industry-specific terms
just check             # all of the above, the local CI mirror
just dev-default       # wrangler dev for apps/default (port 8787)
```

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
| What are we building next?                | The plan file in `~/.claude/plans/` and the active TaskList. |

## Phase-0 finish line

You are at Phase 0 done when:
- `just check` is green from a clean clone in under 5 minutes.
- `packages/core` ships pure-domain code with C1 100 % branch coverage.
- ADR-0002 through ADR-0015 are present and indexed.
- `wrangler dev` starts in `apps/default` and answers a request.

Phase 1 begins after that mark and adds the customer-facing reservation
flow (HoldSlot / ConfirmBooking / CancelBooking / RescheduleBooking),
the DurableObject `DaySchedule`, and the SvelteKit pages.
