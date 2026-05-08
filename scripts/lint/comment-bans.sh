#!/usr/bin/env bash
# Reject "historical narrative" tokens from code / docs (queue-side
# of the repo). git log + ADRs own the milestone trail; the source
# tree only describes the present.
#
# The pattern list lives in `comment-bans.pattern` so neither this
# wrapper nor lefthook nor Justfile re-spell the offending tokens.
#
# Allow:
#   - docs/adr/**         (decision archive — keeps cross-references)
#   - docs/ADR_INDEX.md   (the ADR table; titles legitimately keep
#                          historical phase references)
#   - CHANGELOG.md        (release log)
#   - .gitleaks.toml      (allow-list patterns reference TypeIDs)
#   - _typos.toml         (typo allow-list reference)
#   - wrangler.toml       (DO migration tags = immutable Cloudflare
#                          history; Cloudflare uses the names to track
#                          the actor-class lineage on the live deploy)
#   - scripts/lint/**     (the pattern file itself contains the tokens)
#
# Args: optional path glob list, defaults to packages + apps + docs +
# README.md + CONTRIBUTING.md.
set -euo pipefail

PATTERN_FILE="$(dirname "$0")/comment-bans.pattern"

if [ "$#" -eq 0 ]; then
  set -- packages apps docs README.md CONTRIBUTING.md
fi

EXCLUDES=(
  --glob '!docs/adr/**'
  --glob '!docs/ADR_INDEX.md'
  --glob '!CHANGELOG.md'
  --glob '!.gitleaks.toml'
  --glob '!_typos.toml'
  --glob '!docs/error-codes.md'
  --glob '!**/wrangler.toml'
  --glob '!scripts/lint/**'
  # Docs that still reference the slot-graph era; the queue-pivot
  # rewrite for these lands in the docs follow-up plan.
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
     -f "$PATTERN_FILE" "${EXCLUDES[@]}" "$@" >&2; then
  cat >&2 <<'MSG'

[comment-bans] historical narrative tokens detected.
The source tree should describe the present: ADRs and CHANGELOG own
the milestone trail. Either remove the phrase, move the context to
an ADR, or extend the pattern allow-list.
Pattern source: scripts/lint/comment-bans.pattern
MSG
  exit 1
fi
