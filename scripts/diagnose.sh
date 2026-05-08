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

# ---- run all sub-gates ---------------------------------------------------
# Each sub-script writes:
#   - .diagnose/<gate>.status        single line `PASS:<n>` or `FAIL:<n>`
#   - .diagnose/<gate>-detail.md     per-gate detail markdown
echo "→ typecheck"
bash scripts/diagnose-tsc.sh >/dev/null

# Phase B/C will append more sub-script invocations here.

# ---- summary table -------------------------------------------------------
read_status() {
  local gate="$1"
  local file=".diagnose/${gate}.status"
  if [ ! -f "$file" ]; then
    echo "—:—"
  else
    cat "$file"
  fi
}

# Compact per-gate top files / rules for the summary row. Picks the
# first 3 entries from the gate's detail file by extracting list items.
top3() {
  local gate="$1"
  local file=".diagnose/${gate}-detail.md"
  if [ ! -f "$file" ]; then
    echo "—"
    return
  fi
  awk '/^### top files/{flag=1; next} /^###/{flag=0} flag && /^  - /' "$file" \
    | head -3 \
    | sed -E 's/^  - //; s/ — / (/; s/$/)/' \
    | paste -sd '; ' \
    | sed 's/$/\./'
}

format_row() {
  local gate="$1"
  local label="$2"
  local raw=$(read_status "$gate")
  local status="${raw%%:*}"
  local count="${raw##*:}"
  local top=$(top3 "$gate")
  [ -z "$top" ] && top="—"
  printf "| %-13s | %-6s | %-5s | %s |\n" "$label" "$status" "$count" "$top"
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

{
  echo "# diagnose summary"
  echo
  echo "_Generated: $(now)_"
  echo
  echo "| gate          | status | count | top files / rules |"
  echo "|---------------|--------|-------|-------------------|"
  format_row typecheck "typecheck"
  echo
  echo "_Phase B/C extend this table with biome / eslint / arch / test / guards._"
  echo
  echo "Detail: see \`.diagnose/last-run-detail.md\` for per-gate top files / rules."
} | tee "$out"

# ---- detail aggregation --------------------------------------------------
{
  echo "# diagnose detail"
  echo
  for gate in typecheck; do
    f=".diagnose/${gate}-detail.md"
    if [ -f "$f" ]; then
      cat "$f"
      echo
    fi
  done
} > "$detail"

exit 0
