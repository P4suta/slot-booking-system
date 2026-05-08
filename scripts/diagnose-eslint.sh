#!/usr/bin/env bash
# ESLint deep-dive (queue-pivot DX Phase C).
#
# Runs `eslint --format=json` inside the dev container and aggregates
# messages by file + by rule.

set +e
set -u
set -o pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p .diagnose
log=".diagnose/eslint.log"
status_file=".diagnose/eslint.status"
detail=".diagnose/eslint-detail.md"

DEV="docker compose run --rm -T dev"

# `--max-warnings 0` mirrors `just lint-eslint`. The JSON formatter
# returns an array; exit code is non-zero when any message is emitted
# above the warning threshold.
$DEV ./node_modules/.bin/eslint . --format=json --max-warnings 0 >"$log" 2>/dev/null
exit_code=$?

errors=$(jq -r 'map(.errorCount) | add // 0' "$log" 2>/dev/null || echo "0")
warnings=$(jq -r 'map(.warningCount) | add // 0' "$log" 2>/dev/null || echo "0")
total=$((errors + warnings))
if [ "$exit_code" -eq 0 ]; then
  status="PASS"
else
  status="FAIL"
fi
echo "${status}:${total}" > "$status_file"

{
  echo "## eslint"
  echo
  echo "Status: **$status** (exit $exit_code, errors $errors, warnings $warnings)"
  echo
  if [ "$total" -eq 0 ]; then
    echo "_no diagnostics_"
    exit 0
  fi
  echo "### top files"
  echo
  jq -r '.[] | select((.errorCount + .warningCount) > 0) | "\(.errorCount + .warningCount) \(.filePath)"' "$log" 2>/dev/null \
    | sort -rn | head -10 \
    | awk '{count=$1; $1=""; sub(/^ /, ""); printf "  - %s — %d\n", $0, count}'
  echo
  echo "### top rules"
  echo
  jq -r '.[].messages[]?.ruleId // "no-rule"' "$log" 2>/dev/null \
    | sort | uniq -c | sort -rn | head -10 \
    | awk '{count=$1; $1=""; sub(/^ /, ""); printf "  - %s — %d\n", $0, count}'
} > "$detail"

cat "$detail"
exit 0
