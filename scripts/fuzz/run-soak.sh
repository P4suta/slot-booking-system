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

NUM_RUNS="${FC_NUM_RUNS:-100000}"
# Per-property vitest testTimeout. Scales with the iteration count
# so a 10k soak gets a comfortable 80 s/property cap and a 100k+
# soak still fits without false-positive 5 s timeouts. The
# heuristic is `~5 ms / iter + 30 s baseline` calibrated to the
# slowest property in the suite (log-pii @ ~470 ms / 1000 iters).
TEST_TIMEOUT_MS=$(( NUM_RUNS * 5 + 30000 ))

properties=$(ls packages/core/test/property/*.property.test.ts 2>/dev/null | wc -l)
echo "[fuzz] FC_NUM_RUNS=$NUM_RUNS testTimeout=${TEST_TIMEOUT_MS}ms properties=$properties"
echo "[fuzz] each property runs ${NUM_RUNS} fast-check iterations; vitest verbose reporter prints one line per property as it completes."

started=$(date +%s)

# Heartbeat: prints `[fuzz] still running… (Ns elapsed)` every
# 10 s so the operator can tell the difference between "deep soak
# in progress" and "stuck on something". Killed on EXIT so the
# trailing prompt isn't garbled.
heartbeat() {
  while sleep 10; do
    elapsed=$(( $(date +%s) - started ))
    printf '[fuzz] still running… (%ss elapsed)\n' "$elapsed" >&2
  done
}
heartbeat &
heartbeat_pid=$!
trap 'kill "$heartbeat_pid" 2>/dev/null || true' EXIT

status=0

# Stage 1 — core property tests (in-process domain + Effect).
# These iterate fast (~1 ms / iteration) so 100k+ runs in seconds.
echo "[fuzz] stage 1 / 2 — core property tests (packages/core)"
bash scripts/dev-exec.sh env "FC_NUM_RUNS=$NUM_RUNS" \
  corepack pnpm -F @booking/core exec vitest run --reporter=verbose \
  --test-timeout="$TEST_TIMEOUT_MS" test/property || status=$?

# Stage 2 — integration property tests through the full HTTP +
# DurableObject + D1 stack. Each iteration is heavier (~10-50 ms
# Miniflare round-trip), so the per-test fuzz cap inside
# `numRunsIntegration` keeps the budget realistic regardless of
# `FC_NUM_RUNS`. The vitest-pool-workers 0.16 runner-exit hang
# is absorbed by the integration-side test deadline as usual.
if [ "$status" -eq 0 ]; then
  echo "[fuzz] stage 2 / 2 — integration property tests (apps/default workers project)"
  bash scripts/dev-exec.sh env "FC_NUM_RUNS=$NUM_RUNS" "TEST_DEADLINE=120" \
    bash scripts/test-runner.sh default --test-timeout="$TEST_TIMEOUT_MS" \
    test/integration/property || status=$?
fi

elapsed=$(( $(date +%s) - started ))

kill "$heartbeat_pid" 2>/dev/null || true

if [ "$status" -eq 0 ]; then
  printf '[fuzz] ✓ all property assertions passed in %ss (%s iterations / property)\n' \
    "$elapsed" "$NUM_RUNS"
else
  printf '[fuzz] ✗ failure detected after %ss (exit=%s)\n' "$elapsed" "$status" >&2
fi
exit "$status"
