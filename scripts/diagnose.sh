#!/usr/bin/env bash
# Multi-gate diagnostic surface (queue-pivot DX Phase A-E).
#
# Runs every quality gate `just check` would, but with `set +e` so a
# failing gate does not short-circuit the rest. Each gate's status
# (PASS / FAIL / count) lands in `.diagnose/last-run.md` and stdout
# as a markdown table; per-gate detail (top files, top error codes,
# top rules) is appended below the summary in
# `.diagnose/last-run-detail.md`.
#
# Each sub-script is responsible for:
#   - .diagnose/<gate>.status          single line `PASS:<n>` / `FAIL:<n>`
#   - .diagnose/<gate>-detail.md       markdown detail
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
detail_out=".diagnose/last-run-detail.md"

# ---- run all sub-gates ---------------------------------------------------
echo "→ typecheck"
bash scripts/diagnose-tsc.sh >/dev/null
echo "→ biome"
bash scripts/diagnose-biome.sh >/dev/null
echo "→ eslint"
bash scripts/diagnose-eslint.sh >/dev/null
echo "→ arch"
bash scripts/diagnose-arch.sh >/dev/null
echo "→ test"
bash scripts/diagnose-test.sh >/dev/null
echo "→ guards"
bash scripts/diagnose-guards.sh >/dev/null

# ---- summary table -------------------------------------------------------
read_status() {
  local file=".diagnose/$1.status"
  if [ ! -f "$file" ]; then echo "—:—"; else cat "$file"; fi
}

# Compact per-gate top files / rules for the summary row. Picks the
# first 2 entries from the gate's detail under any '### top *' header.
top2() {
  local file=".diagnose/$1-detail.md"
  if [ ! -f "$file" ]; then echo "—"; return; fi
  awk '/^### top /{flag=1; next} /^###/{flag=0} flag && /^  - /' "$file" \
    | head -2 \
    | sed -E 's/^  - //; s/ — /(/; s/$/)/' \
    | paste -sd ' / ' \
    | sed 's|/|;|g' \
    | head -c 200
}

format_row() {
  local gate="$1"
  local label="$2"
  local raw=$(read_status "$gate")
  local status="${raw%%:*}"
  local count="${raw##*:}"
  local top=$(top2 "$gate")
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
  format_row biome     "biome"
  format_row eslint    "eslint"
  format_row arch      "arch"
  format_row test      "test"
  echo
  echo "### Guards (pass/fail only)"
  echo
  for g in pii-guard domain-purity strict-code dead-code type-coverage error-docs-drift; do
    sf=".diagnose/guards-${g}.status"
    if [ -f "$sf" ]; then
      raw=$(cat "$sf")
      status="${raw%%:*}"
      hits="${raw##*:}"
      if [ "$status" = "PASS" ]; then
        echo "  - $g: **PASS**"
      else
        echo "  - $g: **FAIL** ($hits log lines)"
      fi
    fi
  done
  echo
  echo "Detail: see \`.diagnose/last-run-detail.md\` for per-gate top files / rules."
} | tee "$out"

# ---- detail aggregation --------------------------------------------------
{
  echo "# diagnose detail"
  echo
  for gate in typecheck biome eslint arch test guards; do
    f=".diagnose/${gate}-detail.md"
    if [ -f "$f" ]; then
      cat "$f"
      echo
    fi
  done
} > "$detail_out"

exit 0
