#!/usr/bin/env bash
# Run a single `just <gate>` with hard timeout, line-buffered I/O,
# and structured exit-status reporting. Used by check-parallel.sh
# to make slow / hung gates loud rather than silent.
#
# Usage: run-gate.sh <gate-name> <timeout-sec> <log-file> <exit-file>
#
# `exit-file` is the orchestrator's signal that the gate finished;
# it stores the gate's exit code as a single line. The
# orchestrator polls for the file to appear rather than relying on
# `wait -n -p pid` (which races with already-reaped children when
# fast gates finish before the orchestrator gets to wait).
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
set -o pipefail

gate=$1
timeout_sec=$2
log_file=$3
exit_file=$4

# SIGTERM trap: when the orchestrator's fail-fast kills the
# pgroup, this runner gets SIGTERM. We want the orchestrator's
# poll loop to see a completion marker so it stops waiting on us.
# Hard-coded 143 (= 128 + SIGTERM) is the conventional shell exit
# status for a SIGTERM-killed process.
write_exit_marker_on_signal() {
  printf '\n[run-gate] %s: terminated by signal\n' "$gate" >>"$log_file" 2>/dev/null || true
  echo "143" >"$exit_file" 2>/dev/null || true
}
trap 'write_exit_marker_on_signal; exit 143' TERM INT

status=0
stdbuf -oL -eL timeout --foreground --kill-after=10 "${timeout_sec}s" \
  just "$gate" >"$log_file" 2>&1 || status=$?

trap - TERM INT

case $status in
  0)   ;;
  124) printf '\n[run-gate] %s: timed out after %ss (SIGTERM)\n' \
         "$gate" "$timeout_sec" >>"$log_file" ;;
  137) printf '\n[run-gate] %s: force-killed after %ss (SIGKILL)\n' \
         "$gate" "$timeout_sec" >>"$log_file" ;;
  *)   printf '\n[run-gate] %s: exit %d\n' "$gate" "$status" >>"$log_file" ;;
esac

# Write the exit code as the orchestrator's completion signal.
# The file is written LAST so polling never sees a partial state
# (status is the only thing the orchestrator needs). The trap
# above covers the abnormal-exit path.
echo "$status" >"$exit_file"
exit "$status"
