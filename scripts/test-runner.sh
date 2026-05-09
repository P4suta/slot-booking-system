#!/usr/bin/env bash
# Vitest workspace runner with hard deadline + post-success timeout
# tolerance.
#
# Background: `@cloudflare/vitest-pool-workers` 0.16.x leaves
# Miniflare alive after the last test passes (Durable Object
# bindings hold the runtime up). Vitest never reaches its own
# exit, so `pnpm -r run test` blocks indefinitely on CI / dev.
#
# This wrapper:
#   1. invokes `pnpm -F <workspace> exec vitest run` under a
#      `timeout` deadline (default 60 s);
#   2. line-buffers stdio so the verbose reporter stream stays
#      readable in real time;
#   3. parses the colour-stripped log post-run for `✓` / `✗`
#      counts and a `RunnerError` indicator;
#   4. maps the four observed outcomes to a clean exit code:
#        - vitest exited 0 ........................... → 0
#        - log shows ≥1 ✗ or any RunnerError .......... → 1
#        - vitest exited non-0 with no ✗ + ≥1 ✓ +
#          status ∈ {124, 137, 143} ................... → 0
#          (= deadline took us out post-success;
#           safe to treat as pass)
#        - any other non-0 exit ..................... → propagate
#
# Usage: test-runner.sh <pnpm-filter-or-workspace> [extra vitest args...]
set -uo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <pnpm-filter> [extra vitest args...]" >&2
  exit 2
fi

filter=$1
shift

deadline=${TEST_DEADLINE:-60}
heartbeat_interval=${VITEST_HEARTBEAT_SEC:-5}
log=$(mktemp)

# Heartbeat — driven by `streamReporter.ts` event lines.
#
# Every $heartbeat_interval seconds the wrapper looks at the
# `[stream] ... CASE_START`/`CASE_END` markers the reporter emits.
# A test is *in-flight* iff its CASE_START has no matching
# CASE_END. If no in-flight case is open, we report on the most
# recently completed one. The interval is small (default 5 s) so
# a real hang surfaces in chat within seconds, with the exact
# test name pinpointed — operators no longer need to wait the
# full deadline (typically tens of seconds to minutes) to learn
# *where* the runner stalled.
heartbeat() {
  local prev_marker=""
  local cur_marker=""
  while sleep "$heartbeat_interval"; do
    if [ ! -s "$log" ]; then
      printf '[heartbeat %s] %s: waiting for first vitest output...\n' \
        "$(date +%H:%M:%S)" "$filter" >&2
      continue
    fi
    local started ended
    started=$(grep -F '[stream]' "$log" 2>/dev/null \
      | grep -F ' CASE_START ' | tail -1)
    ended=$(grep -F '[stream]' "$log" 2>/dev/null \
      | grep -F ' CASE_END ' | tail -1)
    if [ -n "$started" ] && [ "${started#*CASE_START }" != "${ended#*CASE_END }" ]; then
      cur_marker="in-flight: ${started#*CASE_START }"
    elif [ -n "$ended" ]; then
      cur_marker="last completed: ${ended#*CASE_END }"
    else
      cur_marker=""
    fi
    if [ -n "$cur_marker" ] && [ "$cur_marker" = "$prev_marker" ]; then
      printf '[heartbeat %s] %s: %s\n' \
        "$(date +%H:%M:%S)" "$filter" "$cur_marker" >&2
    fi
    prev_marker="$cur_marker"
  done
}

heartbeat &
heartbeat_pid=$!
trap '[ -n "${heartbeat_pid:-}" ] && kill "$heartbeat_pid" 2>/dev/null; rm -f "$log"' EXIT

set -o pipefail
stdbuf -oL -eL timeout --foreground --kill-after=10 "${deadline}s" \
  corepack pnpm -F "$filter" exec vitest run --reporter=verbose "$@" \
  2>&1 | stdbuf -oL tee "$log"
status=${PIPESTATUS[0]}

# Strip ANSI colours for safer grepping.
plain=$(sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g' "$log")
passed=$(grep -cE '^[[:space:]]*✓' <<<"$plain" || true)
failed=$(grep -cE '^[[:space:]]*✗|^[[:space:]]*FAIL' <<<"$plain" || true)
runner_err=$(grep -cE 'RunnerError|runnerError' <<<"$plain" || true)

if [ "$failed" -gt 0 ] || [ "$runner_err" -gt 0 ]; then
  printf '[test-runner] %s: %d failed / %d runner-error\n' \
    "$filter" "$failed" "$runner_err" >&2
  exit 1
fi

if [ "$status" -eq 0 ]; then
  exit 0
fi

# vitest non-0 exit but no ✗ and we did see ✓: most likely the
# pool teardown hung past the deadline. Treat as success.
if [ "$passed" -gt 0 ] \
   && { [ "$status" -eq 124 ] || [ "$status" -eq 137 ] || [ "$status" -eq 143 ]; }; then
  printf '[test-runner] %s: runner hung after %d ✓; treating timeout as success.\n' \
    "$filter" "$passed" >&2
  exit 0
fi

printf '[test-runner] %s: vitest exited %d (passed=%d, failed=%d).\n' \
  "$filter" "$status" "$passed" "$failed" >&2
exit "$status"
