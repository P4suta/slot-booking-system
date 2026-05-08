# ADR-0060: comment-bans lint gate

- Status: Accepted
- Date: 2026-05-09
- Refines: ADR-0008 (industry-purity discipline)

## Decision

A grep-driven lint gate (`scripts/lint/comment-bans.sh`) rejects
historical-narrative tokens from code, docs, and configuration.
The forbidden-token list lives in
`scripts/lint/comment-bans.pattern` (so the pattern file does not
self-trigger), and the gate is wired into:

  - `lefthook.yml` `pre-commit` (`comment-bans-staged`, fast path
    over staged files only)
  - `lefthook.yml` `pre-push` (`comment-bans-full`, full repo)
  - `Justfile` `comment-bans` recipe (CI mirror)
  - `Justfile` `check` (the local CI gate that must stay green
    before push)

The pattern file currently bans: `Phase \d+`, `PR#\d+`, `M\d{2}`,
`BI-\d+`, `slot.graph`, `booking.graph`, `DaySchedule`, `Pothos`,
`GraphQL Yoga`, `gql.tada`, `holdSlot`, `availableSlots`,
`computeAvailableSlots`, `BookingCommon`. New entries land
through code review, not unilateral edits.

## Context

The slot-graph era left ~22 files with `Phase 0.7-β2`, `M19`,
`PR#7`, and other milestone references in JSDoc. The repo is
supposed to describe the present; ADRs and CHANGELOG own the
milestone trail. Manual cleanup is unstable — a fresh PR
re-introduces the tokens because the writer has no signal that
the convention exists.

The grep gate is the cheapest enforcement that catches every
case at the right time: pre-commit for the changed files (so the
author sees the failure immediately), pre-push as a full-repo
sweep (so a missed file does not slip through). The pattern file
is intentionally external so the gate can ban tokens that would
otherwise tag the gate's source itself.

## Consequences

- Adding a forbidden token to the codebase is now a hard
  rejection at commit time. Removing one is a single-line
  pattern-file edit (with the matching ADR if the convention
  expanded).
- The exempt list in the script handles legitimate carriers:
  `docs/adr/**` (decision archive — keeps cross-references),
  `CHANGELOG.md` (release log), `wrangler.toml` (DO migration
  tags = immutable Cloudflare history), `scripts/lint/**` (the
  pattern file). The list is intentionally short and any
  expansion lands in code review.
- The gate had a latent bug where positional staged-file
  arguments bypassed the `--glob` exclude (ripgrep filters glob
  during traversal, not positional args). The fix re-filters the
  inputs in shell before handing them to ripgrep so the staged-
  files path matches the full-scan path.

Superseded-By:
