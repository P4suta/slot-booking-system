#!/usr/bin/env bash
# Dependency-cruiser (arch) deep-dive (queue-pivot DX Phase C).
#
# Runs `depcruise --output-type=json` inside the dev container and
# aggregates violations by rule + by source file.

set +e
set -u
set -o pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p .diagnose
log=".diagnose/arch.log"
status_file=".diagnose/arch.status"
detail=".diagnose/arch-detail.md"

DEV="docker compose run --rm -T dev"

$DEV ./node_modules/.bin/depcruise --output-type=json --validate .dependency-cruiser.cjs packages/core/src apps >"$log" 2>/dev/null
exit_code=$?

errors=$(jq -r '.summary.error // 0' "$log" 2>/dev/null || echo "0")
warns=$(jq -r '.summary.warn // 0' "$log" 2>/dev/null || echo "0")
total=$((errors + warns))
if [ "$exit_code" -eq 0 ]; then
  status="PASS"
else
  status="FAIL"
fi
echo "${status}:${total}" > "$status_file"

{
  echo "## arch (dependency-cruiser)"
  echo
  echo "Status: **$status** (exit $exit_code, errors $errors, warns $warns)"
  echo
  if [ "$total" -eq 0 ]; then
    echo "_no violations_"
    exit 0
  fi
  echo "### top rules"
  echo
  jq -r '.summary.violations[]?.rule.name // empty' "$log" 2>/dev/null \
    | sort | uniq -c | sort -rn | head -10 \
    | awk '{count=$1; $1=""; sub(/^ /, ""); printf "  - %s — %d\n", $0, count}'
  echo
  echo "### top sources"
  echo
  jq -r '.summary.violations[]?.from // empty' "$log" 2>/dev/null \
    | sort | uniq -c | sort -rn | head -10 \
    | awk '{count=$1; $1=""; sub(/^ /, ""); printf "  - %s — %d\n", $0, count}'
} > "$detail"

cat "$detail"
exit 0
