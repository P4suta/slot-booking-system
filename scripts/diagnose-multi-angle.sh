#!/usr/bin/env bash
# Diagnose-first multi-angle observability snapshot (C14).
#
# Wraps the existing 6-gate `just diagnose` aggregator and extends
# it with three new dimensions the diagnose-first train cares
# about:
#
#   - **skip-by-TODO-tag count** — every `it.skip` / `it.todo`
#     paired with a `TODO(diagnose-train…)` comment is the
#     priority-ordered backlog of pinned-but-unimplemented spec.
#   - **error-tag coverage matrix** — `errorClassRegistry` tags
#     vs the integration tests that actually exercise them. The
#     diff is the operator's "which envelope path is unobserved
#     in CI today?" punch list.
#   - **silent-failure residual** — every `\.catch\(\(\) => null\)`
#     / `console\.error` / bare-throw site under `apps/` +
#     `packages/`. Targets ZERO; the train fails its own
#     completion definition until this list empties.
#
# Output: `.diagnose/multi-angle.md` (markdown table + detail
# sections). Exit code is **always 0** — diagnose is a snapshot,
# not a gate.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Run the underlying 6-gate diagnose first; we layer the three
# new dimensions on top of its output.
bash scripts/diagnose.sh >/dev/null

mkdir -p .diagnose
out=".diagnose/multi-angle.md"

# ---- skip-by-TODO-tag count ------------------------------------
todo_lines=$(rg --pcre2 -n -t ts \
  -e 'it\.(skip|todo)\(' \
  packages apps 2>/dev/null \
  | grep -v node_modules || true)
todo_count=$(printf '%s\n' "$todo_lines" | grep -c . || true)

# ---- error-tag coverage matrix ---------------------------------
# The 17 registry tags (kept in lockstep with `errorClassRegistry`
# at compile time via `errorEnvelope.test.ts`'s matrix). The
# integration tests that exercise each tag are surfaced via
# `expect.toBe("<Tag>")` calls under `test/integration/`.
all_tags=(
  InvalidPhoneLast4 InvalidNameKana InvalidFreeText InvalidBusinessTimeZone
  InvalidEntityId MissingStaffCapability PhoneMismatch TicketNotFound
  QueueEmpty AlreadyCancelled AlreadyCompleted AlreadyNoShow
  InvalidStateTransition InsufficientCapability AggregateNotFound
  Concurrency Storage
)
declare -A tag_hit
for t in "${all_tags[@]}"; do tag_hit[$t]=0; done
while IFS= read -r line; do
  for t in "${all_tags[@]}"; do
    if printf '%s' "$line" | grep -q "\"$t\""; then
      tag_hit[$t]=1
    fi
  done
done < <(rg -n --no-heading 'expect.*toBe.*"' apps/default/test/integration 2>/dev/null || true)

covered=0
missing=()
for t in "${all_tags[@]}"; do
  if [ "${tag_hit[$t]}" -eq 1 ]; then
    covered=$((covered + 1))
  else
    missing+=("$t")
  fi
done

# ---- silent-failure residual ------------------------------------
silent_lines=$(rg -U --pcre2 -n -t ts \
  -e '\.catch\(\(\)\s*=>\s*null\)' \
  -e 'console\.error\((?![^)]*JSON\.stringify)' \
  apps packages 2>/dev/null \
  | grep -v 'node_modules' \
  | grep -v 'silentJsonParse.integration.test.ts' \
  | grep -v 'WorkersLoggerLive.ts' \
  || true)
silent_count=$(printf '%s\n' "$silent_lines" | grep -c . || true)

# ---- write report ----------------------------------------------
{
  echo "# Multi-angle diagnose snapshot"
  echo
  echo "_Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)_"
  echo
  echo "## Headline (3 new dimensions)"
  echo
  echo "| dimension | value | target |"
  echo "| --- | --- | --- |"
  printf '| skip-by-TODO-tag count | %s | 0 |\n' "$todo_count"
  printf '| error-tag coverage | %d / %d | 17 / 17 |\n' "$covered" "${#all_tags[@]}"
  printf '| silent-failure residual | %s | 0 |\n' "$silent_count"
  echo
  if [ "$todo_count" -gt 0 ]; then
    echo "### skip-by-TODO-tag detail"
    echo
    echo '```'
    printf '%s\n' "$todo_lines"
    echo '```'
    echo
  fi
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "### error-tag uncovered (no integration test asserts these tags)"
    echo
    for t in "${missing[@]}"; do
      printf -- '- %s\n' "$t"
    done
    echo
  fi
  if [ "$silent_count" -gt 0 ]; then
    echo "### silent-failure residual detail"
    echo
    echo '```'
    printf '%s\n' "$silent_lines"
    echo '```'
    echo
  fi
  echo "## Underlying gate snapshot"
  echo
  if [ -f .diagnose/last-run.md ]; then
    cat .diagnose/last-run.md
  fi
} > "$out"

echo "→ wrote $out"
exit 0
