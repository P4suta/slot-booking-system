#!/usr/bin/env bash
# Run `just check` gates concurrently with per-gate hard timeout
# and fail-fast (first failure SIGTERMs all siblings).
#
# Each gate runs in its own process group via `setsid`, which
# means a single SIGTERM tears down the whole `just <gate> →
# scripts/dev-exec.sh → docker exec → underlying tool` tree
# instead of orphaning the docker exec.
#
# Realtime progress: every fork prints `[start] <gate>` and every
# completion prints `[done]  <gate> (Xs, exit=N)` plus the gate's
# full log inline. A hung gate is therefore immediately visible
# without waiting for its per-gate timeout — the operator sees
# "started but not done" up to the deadline.
#
# The orchestrator detects completion via per-gate exit files
# rather than `wait -n -p pid`. The latter races with already-
# reaped children when fast gates finish before the parent gets
# to call wait, so `pid` comes back unset and the diagnostic
# attribution drifts.
set -o pipefail

GATES=(
  "lint-biome:30"
  "lint-eslint:60"
  "markdownlint:30"
  "typecheck:60"
  "arch:30"
  "comment-bans:30"
  "strict-code:30"
  "dead-code:60"
  "type-coverage:60"
  "test-coverage:120"
  "size-limit-core:120"
  "error-docs-drift-check:60"
)

now() { date +%s; }
elapsed_since() { echo "$(( $(now) - $1 ))"; }

session_started=$(now)

echo "[boot] dev-exec warmup ..."
bash scripts/dev-exec.sh true >/dev/null
echo "[boot] dev-exec ready ($(elapsed_since "$session_started")s)"

tmpdir=$(mktemp -d)

# Map: gate-name → "PID:STARTED_TS"
declare -A gate_state
gate_pid()     { echo "${gate_state[$1]%:*}"; }
gate_started() { echo "${gate_state[$1]##*:}"; }

cleanup() {
  for g in "${!gate_state[@]}"; do
    pid=$(gate_pid "$g")
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  rm -rf "$tmpdir"
}
trap cleanup EXIT

for entry in "${GATES[@]}"; do
  gate=${entry%:*}
  timeout_sec=${entry#*:}
  log="$tmpdir/$gate.log"
  exit_file="$tmpdir/$gate.exit"
  echo "[start] $gate (timeout=${timeout_sec}s)"
  setsid bash scripts/run-gate.sh "$gate" "$timeout_sec" "$log" "$exit_file" &
  gate_state[$gate]="$!:$(now)"
done

fail=0
failed=()
killed_by_us=()
fail_fast_triggered=0

# Poll each gate's `.exit` file. 100 ms granularity is fine for
# a 12-gate suite that takes 10-15 s end-to-end; we trade a tiny
# busy-wait for not-having-to-fight `wait -n` race conditions.
while [ "${#gate_state[@]}" -gt 0 ]; do
  for gate in "${!gate_state[@]}"; do
    exit_file="$tmpdir/$gate.exit"
    [ -s "$exit_file" ] || continue
    status=$(<"$exit_file")
    started=$(gate_started "$gate")
    pid=$(gate_pid "$gate")
    unset "gate_state[$gate]"
    # Ensure the child is fully reaped so its job-table entry
    # doesn't linger (avoids the next iteration's `wait -n`
    # confusion if we ever re-introduce it).
    wait "$pid" 2>/dev/null || true
    # Was this gate killed by our fail-fast? If so, label it
    # `killed` rather than treating it as a fresh failure.
    is_killed=0
    for k in "${killed_by_us[@]}"; do
      if [ "$k" = "$gate" ]; then
        is_killed=1
        break
      fi
    done
    if [ "$is_killed" -eq 1 ]; then
      echo "[done]  $gate ($(elapsed_since "$started")s, killed by fail-fast)"
    else
      echo "[done]  $gate ($(elapsed_since "$started")s, exit=$status)"
    fi
    if [ -f "$tmpdir/$gate.log" ] && [ -s "$tmpdir/$gate.log" ]; then
      sed "s|^|        [$gate] |" "$tmpdir/$gate.log"
    fi
    if [ "$status" -ne 0 ] && [ "$is_killed" -eq 0 ]; then
      failed+=("$gate(exit=$status)")
      fail=1
      if [ "$fail_fast_triggered" -eq 0 ]; then
        fail_fast_triggered=1
        survivors=("${!gate_state[@]}")
        if [ "${#survivors[@]}" -gt 0 ]; then
          echo "[abort] killing ${#survivors[@]} siblings (fail-fast on $gate)"
        fi
        for surv_gate in "${survivors[@]}"; do
          killed_by_us+=("$surv_gate")
          surv_pid=$(gate_pid "$surv_gate")
          kill -TERM "-$surv_pid" 2>/dev/null || kill -TERM "$surv_pid" 2>/dev/null || true
        done
      fi
    fi
  done
  if [ "${#gate_state[@]}" -gt 0 ]; then
    sleep 0.1
  fi
done

total=$(elapsed_since "$session_started")
if [ $fail -ne 0 ]; then
  printf '\n[check-parallel] ✗ failed in %ss: %s\n' "$total" "${failed[*]}" >&2
else
  printf '\n[check-parallel] ✓ all gates green in %ss\n' "$total"
fi
exit $fail
