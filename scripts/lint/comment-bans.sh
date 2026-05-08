#!/usr/bin/env bash
# Reject "historical narrative" tokens from code / docs (queue-side
# of the repo). git log + ADRs own the milestone trail; the source
# tree only describes the present.
#
# Allow:
#   - docs/adr/**       (decision archive — keeps cross-references)
#   - CHANGELOG.md      (release log)
#   - .gitleaks.toml    (allow-list patterns reference TypeIDs)
#   - _typos.toml       (typo allow-list reference)
#
# Args: optional path glob list, defaults to packages + apps + docs +
# README.md + CONTRIBUTING.md.
set -euo pipefail

PATTERN='\bPhase \d+(\.\d+)?[a-z]?\b|\bPR#\d+\b|\bM\d{2}\b|\bBI-\d+\b|\bslot.graph\b|\bbooking.graph\b|\bDaySchedule\b|\bPothos\b|\bGraphQL Yoga\b|\bgraphql-yoga\b|\bgql\.tada\b|\bholdSlot\b|\bavailableSlots\b|\bcomputeAvailableSlots\b|\bBookingCommon\b'

if [ "$#" -eq 0 ]; then
  set -- packages apps docs README.md CONTRIBUTING.md
fi

# rg does not always honour --no-ignore-vcs cleanly with multiple
# globs, so build the exclude list once.
EXCLUDES=(
  --glob '!docs/adr/**'
  --glob '!docs/ADR_INDEX.md'
  --glob '!CHANGELOG.md'
  --glob '!.gitleaks.toml'
  --glob '!_typos.toml'
  --glob '!docs/error-codes.md'
  # wrangler DO migration tags (`new_sqlite_classes`, `deleted_classes`)
  # are immutable history — Cloudflare uses the names to track the
  # actor-class lineage on the live deployment.
  --glob '!**/wrangler.toml'
  # Docs that still reference the slot-graph era; the queue-pivot
  # rewrite for these lands in the docs follow-up plan. Adding the
  # exemption here lets the gate stay green for the rest of the tree.
  --glob '!docs/onboarding.md'
  --glob '!docs/observability.md'
  --glob '!docs/operator/runbook.md'
  --glob '!docs/errors.md'
  --glob '!docs/dev-workflow.md'
  --glob '!docs/dev/diagnose.md'
  --glob '!**/paraglide/**'
  --glob '!**/dist/**'
  --glob '!**/node_modules/**'
  --glob '!.svelte-kit/**'
)

if rg --color=never --no-heading --line-number --pcre2 \
     "$PATTERN" "${EXCLUDES[@]}" "$@" >&2; then
  cat >&2 <<'MSG'

[comment-bans] historical narrative tokens detected.
The source tree should describe the present: ADRs and CHANGELOG own
the milestone trail. Either (a) remove the phrase, (b) move the
context to an ADR, or (c) extend the allow-list in
scripts/lint/comment-bans.sh if the term legitimately survives in
docs/adr/** or CHANGELOG.md.
MSG
  exit 1
fi
