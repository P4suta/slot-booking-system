#!/usr/bin/env bash
# Typecheck deep-dive (queue-pivot DX Phase B).
#
# Runs `tsc -b` inside the dev container, then aggregates the
# `path(line,col): error TSXXXX:` lines on two axes:
#   - file (top 10): which paths to attack first
#   - error code (top 10): which TSXXXX clusters dominate
#
# Outputs:
#   - .diagnose/typecheck.log         raw tsc stdout/stderr
#   - .diagnose/typecheck.status      single line: PASS|FAIL:<count>
#   - .diagnose/typecheck-detail.md   markdown detail (consumed by diagnose.sh)
#
# Standalone use: `just diagnose-tsc` prints the markdown detail to
# stdout. Aggregated use: `scripts/diagnose.sh` reads the .status
# line + appends the detail to the run summary.

set +e
set -u
set -o pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p .diagnose
log=".diagnose/typecheck.log"
status_file=".diagnose/typecheck.status"
detail=".diagnose/typecheck-detail.md"

DEV="docker compose run --rm -T dev"

# tsc emits to stdout when invoked under -b; the standalone tsc
# version writes to stderr. Capture both, the grep below is robust.
$DEV ./node_modules/.bin/tsc -b >"$log" 2>&1
exit_code=$?

# Each error line is `path(line,col): error TS####: message` (or
# `path:line:col - error TS####:` in newer tsc). The pattern below
# accepts both.
errors=$(grep -E 'error TS[0-9]+' "$log" | wc -l | tr -d ' ')
if [ "$exit_code" -eq 0 ]; then
  status="PASS"
else
  status="FAIL"
fi
echo "${status}:${errors}" > "$status_file"

# ---- markdown detail -----------------------------------------------------
{
  echo "## typecheck"
  echo
  echo "Status: **$status** (exit $exit_code, $errors errors)"
  echo

  if [ "$errors" -eq 0 ]; then
    echo "_no errors_"
    exit 0
  fi

  echo "### top files (top 10)"
  echo
  grep -E 'error TS[0-9]+' "$log" \
    | sed -E 's/[(:][0-9]+[,:][0-9]+\)?:? -? ?error TS[0-9]+:.*$//' \
    | sort \
    | uniq -c \
    | sort -rn \
    | head -10 \
    | awk '{count=$1; $1=""; sub(/^ /, ""); printf "  - %s — %d\n", $0, count}'
  echo

  echo "### error code distribution (top 10)"
  echo
  grep -oE 'error TS[0-9]+' "$log" \
    | sort \
    | uniq -c \
    | sort -rn \
    | head -10 \
    | awk '{printf "  - %s — %d\n", $2 " " $3, $1}'
  echo

  echo "### top error code × file (top 10 pairs)"
  echo
  grep -oE '^[^(]+(\(|:)[0-9]+[,:][0-9]+\)?:? -? ?error TS[0-9]+' "$log" \
    | sed -E 's/[(:][0-9]+[,:][0-9]+\)?:? -? ?(error TS[0-9]+)/ \1/' \
    | sort \
    | uniq -c \
    | sort -rn \
    | head -10 \
    | awk '{count=$1; $1=""; sub(/^ /, ""); printf "  - %s — %d\n", $0, count}'
} > "$detail"

# Echo to stdout so `just diagnose-tsc` shows the report directly.
cat "$detail"

exit 0
