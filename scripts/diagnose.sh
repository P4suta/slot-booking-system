#!/usr/bin/env bash
# Multi-gate diagnostic surface (queue-pivot DX Phase A-E).
#
# Runs every quality gate `just check` would, but with `set +e` so a
# failing gate does not short-circuit the rest. Each gate's status
# (PASS / FAIL / count) lands in `.diagnose/last-run.md` and stdout
# as a markdown table; per-gate detail (top files, top error codes,
# top rules) is appended below the summary.
#
# Phase A wraps `typecheck` only. Phase B/C extend with biome /
# eslint / arch / test JSON aggregations + the rest of the gates.
#
# Exit code is **always 0** — diagnose is a snapshot, not a gate.
# Use `just check` for the fail-fast normative gate.

set +e
set -u
set -o pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p .diagnose
out=".diagnose/last-run.md"
detail=".diagnose/last-run-detail.md"

DEV="docker compose run --rm -T dev"

run_gate() {
  local name="$1"
  local cmd="$2"
  local log_file=".diagnose/${name}.log"
  echo "→ $name"
  bash -c "$cmd" >"$log_file" 2>&1
  local exit_code=$?
  echo "$exit_code" >".diagnose/${name}.exit"
  echo "$log_file"
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

count_tsc_errors() {
  grep -cE 'error TS[0-9]+' "$1" 2>/dev/null || echo 0
}

top_tsc_files() {
  grep -oE '^[^(]+\([0-9]+,[0-9]+\): error TS' "$1" \
    | sed -E 's/\([0-9]+,[0-9]+\): error TS//' \
    | sort | uniq -c | sort -rn | head -3 \
    | awk '{count=$1; $1=""; sub(/^ /, ""); print $0 " (" count ")"}' \
    | paste -sd '; '
}

# ---- typecheck -----------------------------------------------------------
run_gate typecheck "$DEV ./node_modules/.bin/tsc -b" >/dev/null
tsc_log=".diagnose/typecheck.log"
tsc_exit=$(cat .diagnose/typecheck.exit)
tsc_errors=$(count_tsc_errors "$tsc_log")
[ "$tsc_exit" -eq 0 ] && tsc_status="PASS" || tsc_status="FAIL"
tsc_top=$(top_tsc_files "$tsc_log")
[ -z "$tsc_top" ] && tsc_top="—"

# ---- summary -------------------------------------------------------------
{
  echo "# diagnose summary"
  echo
  echo "_Generated: $(now)_"
  echo
  echo "| gate      | status | count | top files                    |"
  echo "|-----------|--------|-------|------------------------------|"
  printf "| %-9s | %-6s | %-5s | %s |\n" "typecheck" "$tsc_status" "$tsc_errors" "$tsc_top"
  echo
  echo "_Phase B/C will extend this table with biome / eslint / arch / test / guards._"
  echo
  echo "Detail: see \`.diagnose/last-run-detail.md\` for per-gate top files / rules."
} | tee "$out"

# ---- detail --------------------------------------------------------------
{
  echo "# diagnose detail"
  echo
  echo "## typecheck (exit $tsc_exit, $tsc_errors errors)"
  echo
  if [ "$tsc_errors" -gt 0 ]; then
    echo "### top files"
    echo
    grep -oE '^[^(]+\([0-9]+,[0-9]+\): error TS' "$tsc_log" \
      | sed -E 's/\([0-9]+,[0-9]+\): error TS//' \
      | sort | uniq -c | sort -rn | head -10 \
      | awk '{count=$1; $1=""; sub(/^ /, ""); printf "  - %s (%s)\n", $0, count}'
    echo
    echo "### error code distribution"
    echo
    grep -oE 'error TS[0-9]+' "$tsc_log" \
      | sort | uniq -c | sort -rn | head -10 \
      | awk '{printf "  - %s (%s)\n", $2, $1}'
  else
    echo "_no errors_"
  fi
} > "$detail"

exit 0
