#!/usr/bin/env bash
# Guard gates pass/fail capture (queue-pivot DX Phase C).
#
# Runs the lightweight regex/grep guards (pii, domain-purity,
# strict-code, dead-code, type-coverage, error-docs-drift) and
# captures pass/fail only — these gates are not amenable to per-file
# JSON aggregation, so the diagnose surface only records whether
# they passed.

set +e
set -u
set -o pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p .diagnose
detail=".diagnose/guards-detail.md"

run() {
  local gate="$1"
  shift
  local log_file=".diagnose/guards-${gate}.log"
  local status_file=".diagnose/guards-${gate}.status"
  echo "→ $gate"
  "$@" >"$log_file" 2>&1
  local exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    echo "PASS:0" > "$status_file"
    echo "  $gate: PASS"
  else
    # Best-effort line count of grep matches / lint violations.
    local hits=$(wc -l < "$log_file" 2>/dev/null | tr -d ' ')
    echo "FAIL:${hits}" > "$status_file"
    echo "  $gate: FAIL ($hits log lines)"
  fi
}

run pii-guard       just pii-guard
run domain-purity   just domain-purity
run strict-code     just strict-code
run dead-code       just dead-code
run type-coverage   just type-coverage
run error-docs-drift just error-docs-drift-check

{
  echo "## guards"
  echo
  for gate in pii-guard domain-purity strict-code dead-code type-coverage error-docs-drift; do
    sf=".diagnose/guards-${gate}.status"
    if [ -f "$sf" ]; then
      raw=$(cat "$sf")
      status="${raw%%:*}"
      hits="${raw##*:}"
      if [ "$status" = "PASS" ]; then
        echo "  - **$gate**: PASS"
      else
        echo "  - **$gate**: FAIL ($hits)"
      fi
    fi
  done
} > "$detail"

cat "$detail"
exit 0
