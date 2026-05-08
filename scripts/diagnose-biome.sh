#!/usr/bin/env bash
# Biome lint deep-dive (queue-pivot DX Phase C).
#
# Runs `biome check --reporter=json` inside the dev container and
# aggregates diagnostics by file + by category. Even with the
# `--json` reporter labelled "unstable" the summary block is stable
# enough to drive the diagnose dashboard.
#
# Outputs:
#   - .diagnose/biome.log         raw json
#   - .diagnose/biome.status      single line PASS|FAIL:<count>
#   - .diagnose/biome-detail.md   markdown detail

set +e
set -u
set -o pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p .diagnose
log=".diagnose/biome.log"
status_file=".diagnose/biome.status"
detail=".diagnose/biome-detail.md"

DEV="docker compose run --rm -T dev"

# `--error-on-warnings` mirrors `just lint-biome`. The json reporter
# emits one JSON document on stdout; non-zero exit = some diagnostic.
$DEV ./node_modules/.bin/biome check --error-on-warnings --reporter=json . >"$log" 2>/dev/null
exit_code=$?

errors=$(jq -r '.summary.errors // 0' "$log" 2>/dev/null || echo "0")
warnings=$(jq -r '.summary.warnings // 0' "$log" 2>/dev/null || echo "0")
total=$((errors + warnings))
if [ "$exit_code" -eq 0 ]; then
  status="PASS"
else
  status="FAIL"
fi
echo "${status}:${total}" > "$status_file"

{
  echo "## biome"
  echo
  echo "Status: **$status** (exit $exit_code, errors $errors, warnings $warnings)"
  echo
  if [ "$total" -eq 0 ]; then
    echo "_no diagnostics_"
    exit 0
  fi
  echo "### top files"
  echo
  jq -r '.diagnostics[]?.location.path.file // empty' "$log" 2>/dev/null \
    | sort | uniq -c | sort -rn | head -10 \
    | awk '{count=$1; $1=""; sub(/^ /, ""); printf "  - %s — %d\n", $0, count}'
  echo
  echo "### top rules"
  echo
  jq -r '.diagnostics[]?.category // empty' "$log" 2>/dev/null \
    | sort | uniq -c | sort -rn | head -10 \
    | awk '{count=$1; $1=""; sub(/^ /, ""); printf "  - %s — %d\n", $0, count}'
} > "$detail"

cat "$detail"
exit 0
