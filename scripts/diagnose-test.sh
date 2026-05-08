#!/usr/bin/env bash
# Vitest deep-dive (queue-pivot DX Phase C).
#
# Runs `vitest run --reporter=json` per workspace and aggregates
# failed tests by file + by suite. The reporter writes one JSON
# document per package; we concatenate the parsed summaries.

set +e
set -u
set -o pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p .diagnose
log=".diagnose/test.log"
status_file=".diagnose/test.status"
detail=".diagnose/test-detail.md"

DEV="bash scripts/dev-exec.sh"

# Each workspace runs its own vitest; concatenate the JSON outputs.
# vitest-pool-workers 0.16 hangs after the apps/default suite passes,
# so the workspace-specific deadlines (60 s for the others, 20 s for
# apps/default) keep this aggregator bounded; see
# `scripts/test-runner.sh` for the rationale.
{
  echo "=== packages/core ==="
  $DEV bash scripts/test-runner.sh @booking/core --reporter=json --silent 2>/dev/null
  echo "=== apps/default ==="
  $DEV env TEST_DEADLINE=20 bash scripts/test-runner.sh default --reporter=json --silent 2>/dev/null
  echo "=== apps/web ==="
  $DEV bash scripts/test-runner.sh web --reporter=json --silent 2>/dev/null
} >"$log" 2>&1

# Total exit code is implicit via the last one; track each package
# separately by parsing the workspace-tagged blocks.
parse_block() {
  local label="$1"
  awk -v label="$label" '
    $0 ~ "^=== " label " ===$" {flag=1; next}
    /^=== / {flag=0}
    flag {print}
  ' "$log"
}

extract_count() {
  local label="$1"
  local key="$2"
  parse_block "$label" | grep -oE "\"${key}\":[0-9]+" | head -1 | grep -oE '[0-9]+' || echo "0"
}

core_failed=$(extract_count "packages/core" numFailedTests)
default_failed=$(extract_count "apps/default" numFailedTests)
web_failed=$(extract_count "apps/web" numFailedTests)
total=$((${core_failed:-0} + ${default_failed:-0} + ${web_failed:-0}))

if [ "$total" -eq 0 ]; then
  status="PASS"
else
  status="FAIL"
fi
echo "${status}:${total}" > "$status_file"

{
  echo "## test (vitest)"
  echo
  echo "Status: **$status** ($total failed tests across 3 workspaces)"
  echo
  echo "  - packages/core: $core_failed failed"
  echo "  - apps/default: $default_failed failed"
  echo "  - apps/web: $web_failed failed"
  echo
  if [ "$total" -gt 0 ]; then
    echo "### failed test paths"
    echo
    parse_block "packages/core" \
      | jq -r '.testResults[]? | select(.status != "passed") | .name // empty' 2>/dev/null \
      | sort | uniq | head -10 \
      | sed 's/^/  - /'
    parse_block "apps/default" \
      | jq -r '.testResults[]? | select(.status != "passed") | .name // empty' 2>/dev/null \
      | sort | uniq | head -10 \
      | sed 's/^/  - /'
    parse_block "apps/web" \
      | jq -r '.testResults[]? | select(.status != "passed") | .name // empty' 2>/dev/null \
      | sort | uniq | head -10 \
      | sed 's/^/  - /'
  fi
} > "$detail"

cat "$detail"
exit 0
