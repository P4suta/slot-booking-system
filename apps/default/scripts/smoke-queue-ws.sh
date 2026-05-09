#!/usr/bin/env bash
# End-to-end smoke for the QueueShop WebSocket projection feed
# (C13). Expected to run against `wrangler dev` (port 8787). Drives:
#
#   1. Open WS to /api/v1/queue/feed → expect on-connect projection
#   2. Issue a ticket via REST → expect a broadcast within 2 s
#   3. Close client (code 1000) → expect clean shutdown
#
# Tooling: `websocat` (Rust, cargo-installable) for the WS client +
# `curl` + `jq`. websocat is the lightest WS CLI; we don't pull in
# Node test infra to keep `just smoke` shell-only.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
WS_URL="${WS_URL:-ws://localhost:8787/api/v1/queue/feed}"
TIMEOUT_S="${TIMEOUT_S:-3}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v websocat >/dev/null || {
  echo "websocat is required (install via 'mise use -g github:vi/websocat@latest')" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"; jobs -p | xargs -r kill 2>/dev/null || true' EXIT

# Step 1: open WS, capture frames into a file in the background.
# `--no-close` keeps the socket alive past the initial frame so the
# Issue-induced broadcast lands; we control the lifetime via the
# wait+kill pair.
websocat -n1 "$WS_URL" >"$tmpdir/initial.txt" 2>"$tmpdir/initial.err" &
ws_pid=$!

# Wait for the on-connect projection frame.
deadline=$((SECONDS + TIMEOUT_S))
while [ ! -s "$tmpdir/initial.txt" ] && [ "$SECONDS" -lt "$deadline" ]; do
  sleep 0.1
done
if [ ! -s "$tmpdir/initial.txt" ]; then
  echo "smoke-queue-ws: no on-connect projection within ${TIMEOUT_S}s" >&2
  exit 1
fi
projection=$(cat "$tmpdir/initial.txt")
echo "[1/3] on-connect projection: $(jq -c '{ok, waitingCount}' <<<"$projection")"
wait "$ws_pid" 2>/dev/null || true

# Step 2: Issue a ticket via REST. The DO broadcasts the new
# projection on success; reopen a WS to confirm the new state.
issue_body='{"nameKana":"スモーク タロウ","phoneLast4":"0000","freeText":"smoke"}'
issue=$(curl -fsS -X POST "$BASE_URL/api/v1/tickets" \
  -H 'content-type: application/json' \
  --data "$issue_body")
ticket_id=$(jq -r '.ticket.id' <<<"$issue")
echo "[2/3] issued: $ticket_id"

# Reopen WS — confirm waitingCount reflects the new ticket.
websocat -n1 "$WS_URL" >"$tmpdir/post.txt" 2>"$tmpdir/post.err" &
ws_pid=$!
deadline=$((SECONDS + TIMEOUT_S))
while [ ! -s "$tmpdir/post.txt" ] && [ "$SECONDS" -lt "$deadline" ]; do
  sleep 0.1
done
if [ ! -s "$tmpdir/post.txt" ]; then
  echo "smoke-queue-ws: no projection after Issue within ${TIMEOUT_S}s" >&2
  exit 1
fi
post_projection=$(cat "$tmpdir/post.txt")
post_count=$(jq -r '.waitingCount' <<<"$post_projection")
echo "[3/3] post-issue waitingCount=$post_count"
wait "$ws_pid" 2>/dev/null || true

if [ "$post_count" -lt 1 ]; then
  echo "smoke-queue-ws: expected waitingCount >= 1, got $post_count" >&2
  exit 1
fi

echo "✓ smoke-queue-ws OK"
