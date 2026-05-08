#!/usr/bin/env bash
# Run `just check` gates concurrently with per-gate hard timeout
# and fail-fast (first failure SIGTERMs all siblings).
#
# Each gate runs in its own process group via `setsid`, which
# means a single SIGTERM tears down the whole `just <gate> →
# scripts/dev-exec.sh → docker exec → underlying tool` tree
# instead of orphaning the docker exec.
#
# Output is line-prefixed `[<gate>]` and only printed once a gate
# finishes — interleaving 12 streams of vitest / pnpm output in
# real time would be unreadable. The trade-off is that you don't
# see progress, but the per-gate timeout absorbs the hang risk
# and prints a diagnostic line when a gate trips it.
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

# Pre-warm the long-running dev container once. All gates exec
# into the same container.
bash scripts/dev-exec.sh true >/dev/null

tmpdir=$(mktemp -d)
declare -A pid_to_gate

cleanup() {
  for pid in "${!pid_to_gate[@]}"; do
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  rm -rf "$tmpdir"
}
trap cleanup EXIT

for entry in "${GATES[@]}"; do
  gate=${entry%:*}
  timeout_sec=${entry#*:}
  log="$tmpdir/$gate.log"
  setsid bash scripts/run-gate.sh "$gate" "$timeout_sec" "$log" &
  pid_to_gate[$!]=$gate
done

fail=0
failed=()

# `wait -n -p` (bash 5.1+) waits for the next-finished child and
# stores its pid in the named variable, so we can fail-fast on the
# first non-zero exit by killing the rest. The loop runs until the
# pid_to_gate map is empty rather than over a fixed counter so a
# missed wait-fill (signal interruption etc.) just retries.
while [ "${#pid_to_gate[@]}" -gt 0 ]; do
  pid=""
  if wait -n -p pid; then
    status=0
  else
    status=$?
  fi
  if [ -z "$pid" ]; then
    # wait reported but didn't surface a pid (signal-interrupted
    # wait, or all children already reaped). Spin once to let the
    # zombie reaper land. Bounded by the per-gate timeout, so the
    # outer just-recipe still has a hard deadline.
    continue
  fi
  gate=${pid_to_gate[$pid]:-unknown}
  unset "pid_to_gate[$pid]"
  if [ -f "$tmpdir/$gate.log" ]; then
    sed "s|^|[$gate] |" "$tmpdir/$gate.log"
  fi
  if [ "$status" -ne 0 ]; then
    failed+=("$gate(exit=$status)")
    fail=1
    for other_pid in "${!pid_to_gate[@]}"; do
      kill -TERM "-$other_pid" 2>/dev/null || kill -TERM "$other_pid" 2>/dev/null || true
    done
  fi
done

if [ $fail -ne 0 ]; then
  printf '\n[check-parallel] failed gates: %s\n' "${failed[*]}" >&2
fi
exit $fail
