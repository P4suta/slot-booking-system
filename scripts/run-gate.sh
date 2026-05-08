#!/usr/bin/env bash
# Run a single `just <gate>` with hard timeout, line-buffered I/O,
# and structured exit-status annotation. Used by check-parallel.sh
# to make slow / hung gates loud rather than silent.
#
# Usage: run-gate.sh <gate-name> <timeout-sec> <log-file>
#
# Why each piece matters:
#   - `stdbuf -oL -eL` forces line-buffered stdout/stderr. Without
#     it, piping to a file flips the libc default to block-
#     buffered; vitest / pnpm output then arrives in 4 KB chunks
#     and a hung gate looks identical to a slow one.
#   - `timeout --foreground --kill-after=10` SIGTERMs the gate at
#     the deadline, then SIGKILLs 10 s later if it ignored the
#     polite signal. `--foreground` sends to the whole process
#     group so child docker / pnpm / vitest go down together.
#   - Exit-status annotation: 124 / 137 / other become readable
#     log lines, so the parallel orchestrator can attribute the
#     failure shape (timeout vs. graceful failure vs. crash).
set -euo pipefail

gate=$1
timeout_sec=$2
log_file=$3

status=0
stdbuf -oL -eL timeout --foreground --kill-after=10 "${timeout_sec}s" \
  just "$gate" >"$log_file" 2>&1 || status=$?

case $status in
  0)   ;;
  124) printf '\n[run-gate] %s: timed out after %ss (SIGTERM)\n' \
         "$gate" "$timeout_sec" >>"$log_file" ;;
  137) printf '\n[run-gate] %s: force-killed after %ss (SIGKILL)\n' \
         "$gate" "$timeout_sec" >>"$log_file" ;;
  *)   printf '\n[run-gate] %s: exit %d\n' "$gate" "$status" >>"$log_file" ;;
esac
exit "$status"
