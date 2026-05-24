#!/usr/bin/env bash
# B6.2 — one-shot migration to fix file ownership when a previous
# docker container ran as root and wrote into the bind-mounted
# workspace. Run this once after the host-user `user:` directive
# in `docker-compose.yml` landed; subsequent container starts
# respect the host UID/GID and produce no root-owned files.
#
# Usage:
#   ./scripts/fix-perms.sh              # chown to host UID:GID (re-execs under sudo)
#   ./scripts/fix-perms.sh --dry-run-detect
#                                       # exit 0 + print every path that still
#                                       # needs chowning; exit 0 + no output if
#                                       # the workspace is already clean.
#                                       # Used by `just bootstrap` to skip the
#                                       # sudo prompt when nothing needs fixing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_UID="${UID:-$(id -u)}"
TARGET_GID="${GID:-$(id -g)}"

# Single source of truth for which artefacts the dev container writes.
# Re-used by both the chown loop and the dry-run detector.
TARGETS=(
  "$HERE/node_modules"
  "$HERE/.pnpm-store"
  "$HERE/.pnpm-home"
  "$HERE/apps/web/src/paraglide"
  "$HERE/apps/web/src/generated"
  "$HERE/apps/web/.svelte-kit"
  "$HERE/apps/default/dist"
  "$HERE/apps/default/.wrangler"
  "$HERE/docs/openapi.json"
)

# --dry-run-detect: report any path whose owner is NOT the host
# user. `find -uid -not -ouid` would be ideal but is bash-specific;
# a portable check uses `stat` on each target's top entry plus a
# bounded find for nested wrong-owner files.
if [ "${1:-}" = "--dry-run-detect" ]; then
  for path in "${TARGETS[@]}"; do
    if [ -e "$path" ]; then
      find "$path" -not -uid "$TARGET_UID" -print -quit 2>/dev/null || true
    fi
  done
  # Per-workspace node_modules / dist / .tsbuildinfo (same find shape
  # as the chown loop below, in -print -quit mode so the first
  # offending entry exits early).
  find "$HERE/apps" "$HERE/packages" "$HERE/scripts" \
    \( -name "node_modules" -o -name "dist" -o -name ".tsbuildinfo*" \) \
    -not -uid "$TARGET_UID" -print -quit 2>/dev/null || true
  exit 0
fi

if [ "$EUID" -ne 0 ]; then
  echo "fix-perms: re-running under sudo (need root to chown files written by the dev container)"
  exec sudo -E "$0" "$@"
fi

echo "fix-perms: chowning workspace contents to ${TARGET_UID}:${TARGET_GID}"

for path in "${TARGETS[@]}"; do
  if [ -e "$path" ]; then
    chown -R "${TARGET_UID}:${TARGET_GID}" "$path"
    echo "  chowned $path"
  fi
done

# Also walk every package's node_modules and tsbuildinfo / dist
# directories the workspaces produce.
find "$HERE/apps" "$HERE/packages" "$HERE/scripts" \
  \( -name "node_modules" -o -name "dist" -o -name ".tsbuildinfo*" \) \
  -exec chown -R "${TARGET_UID}:${TARGET_GID}" {} + 2>/dev/null || true

echo "fix-perms: done"
