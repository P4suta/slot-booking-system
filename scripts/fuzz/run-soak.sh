#!/usr/bin/env bash
# Long-run fuzz soak for the queue domain's property tests (Z1).
#
# Every property under `packages/core/test/property/**` plus the
# transitions ↔ projection homomorphism check now reads
# `FC_NUM_RUNS` to override its per-property `numRuns`. Setting
# `FC_NUM_RUNS=10000` runs each property 10_000 iterations
# instead of the dev-default 30-100. Five properties × 10 000
# iterations completes in ~5 minutes on a warm container.
#
# Usage: `scripts/fuzz/run-soak.sh` (or `just fuzz`).
#
#   FC_NUM_RUNS  override per-property iteration count (default 10000)
#
# Output: stdout streams the verbose vitest reporter so an
# operator can watch progress; the wall-time + per-iteration
# stats land in the final summary line.
#
# Exit code matches the underlying vitest run: any failed
# property → non-zero. The aggregator script doesn't try to
# coerce a counterexample into a clean exit; if a property
# shrinks to a falsifying input, the operator wants the
# pipeline to fail loudly.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

NUM_RUNS="${FC_NUM_RUNS:-10000}"
echo "[fuzz] FC_NUM_RUNS=$NUM_RUNS"

started=$(date +%s)
status=0
bash scripts/dev-exec.sh env "FC_NUM_RUNS=$NUM_RUNS" \
  corepack pnpm -F @booking/core run test:property || status=$?
elapsed=$(( $(date +%s) - started ))

if [ "$status" -eq 0 ]; then
  printf '[fuzz] ✓ all property assertions passed in %ss (%s iterations / property)\n' \
    "$elapsed" "$NUM_RUNS"
else
  printf '[fuzz] ✗ failure detected after %ss (exit=%s)\n' "$elapsed" "$status" >&2
fi
exit "$status"
