#!/usr/bin/env bash
# Run a command inside the long-running `dev` container.
#
# Replaces `docker compose run --rm dev <cmd>` (~800 ms of
# container creation per gate). The dev container stays up for the
# session; this wrapper costs ~35 ms (docker exec) + a one-shot
# ~200 ms `up -d` on the very first call.
#
# The container ID is cached in `.cache/dev-cid` so subsequent
# calls bypass the compose CLI entirely (the compose CLI alone is
# ~100 ms; `docker exec <cid>` is ~35 ms).
set -euo pipefail

CIDFILE=".cache/dev-cid"
mkdir -p "$(dirname "$CIDFILE")"

ensure_up() {
  docker compose up -d dev >/dev/null
  docker compose ps -q dev >"$CIDFILE"
}

if [ ! -s "$CIDFILE" ]; then
  ensure_up
fi

cid=$(<"$CIDFILE")
if [ "$(docker inspect --format='{{.State.Running}}' "$cid" 2>/dev/null)" != "true" ]; then
  ensure_up
  cid=$(<"$CIDFILE")
fi

exec docker exec "$cid" "$@"
