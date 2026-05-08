#!/usr/bin/env bash
# Run `just check` gates concurrently.
#
# Each gate is independent (no shared FS state at runtime; each
# spawns its own docker container or runs host-side). On a 12-gate
# sequential run wall time is the sum (~60 s); concurrent it
# collapses to max(longest gate) + a few seconds of orchestration.
#
# Output is line-prefixed `[<gate>]` so interleaved logs stay
# attributable. On any gate failure the script collects the failing
# names, prints them last, and exits non-zero.
set -uo pipefail

GATES=(
  lint-biome
  lint-eslint
  markdownlint
  typecheck
  arch
  comment-bans
  strict-code
  dead-code
  type-coverage
  test-coverage
  size-limit-core
  error-docs-drift-check
)

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

declare -A pid_to_gate
for gate in "${GATES[@]}"; do
  log="$tmpdir/$gate.log"
  (
    just "$gate" >"$log" 2>&1
  ) &
  pid_to_gate[$!]=$gate
done

fail=0
failed=()
for pid in "${!pid_to_gate[@]}"; do
  gate=${pid_to_gate[$pid]}
  if wait "$pid"; then
    sed -n "s/^/[$gate] /p" "$tmpdir/$gate.log" || true
  else
    sed -n "s/^/[$gate] /p" "$tmpdir/$gate.log" || true
    failed+=("$gate")
    fail=1
  fi
done

if [ $fail -ne 0 ]; then
  printf '\n[check-parallel] failed gates: %s\n' "${failed[*]}" >&2
fi
exit $fail
