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
  # Docs that still carry slot-graph era narrative; the rewrite is
  # an in-flight commit train. Each doc graduates out of this list
  # as it lands the queue-centric rewrite.
  --glob '!docs/observability.md'
  --glob '!docs/operator/runbook.md'
  --glob '!docs/dev-workflow.md'
  --glob '!docs/dev/diagnose.md'
  --glob '!**/paraglide/**'
  --glob '!**/dist/**'
  --glob '!**/node_modules/**'
  --glob '!.svelte-kit/**'
)

# When lefthook passes explicit staged-file arguments, ripgrep's
# `--glob '!pattern'` filters do NOT apply (globs only filter
# directory traversal, not positional file args). Re-filter the
# inputs here so the staged-files path matches the full-scan path.
filtered=()
for f in "$@"; do
  case "$f" in
    docs/adr/*) ;;
    docs/ADR_INDEX.md|CHANGELOG.md|.gitleaks.toml|_typos.toml|docs/error-codes.md) ;;
    */wrangler.toml|wrangler.toml) ;;
    scripts/lint/*) ;;
    docs/observability.md|docs/operator/runbook.md) ;;
    docs/dev-workflow.md|docs/dev/diagnose.md) ;;
    */paraglide/*|*/dist/*|*/node_modules/*|*/.svelte-kit/*) ;;
    *) filtered+=("$f") ;;
  esac
done

# `set --` clears positional args; re-set with the filtered list. If
# no inputs remain after filtering, the gate is a no-op.
if [ ${#filtered[@]} -eq 0 ] && [ "$#" -gt 0 ]; then
  exit 0
fi
if [ ${#filtered[@]} -gt 0 ]; then
  set -- "${filtered[@]}"
fi

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
