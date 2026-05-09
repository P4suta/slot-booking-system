#!/usr/bin/env bash
# End-to-end smoke for the queue REST surface — intended to run
# against `wrangler dev` (default port 8787) after `just dev-up`. The
# script chains the customer issue + staff lifecycle so a curl-only
# operator can confirm the wire format on a fresh wrangler session.
#
# Exit non-zero on any HTTP failure or unexpected envelope shape;
# stdout summarises each step for human reading.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
STAFF_TOKEN="${STAFF_SESSION_SECRET:-dev-placeholder-replace-in-prod}"

# Tooling: jq for response parsing, curl for HTTP. Fail fast if
# either is unavailable — the recipe is shell-only by design.
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

require_jq () {
  local payload="$1"
  local path="$2"
  local got
  got=$(jq -r "$path" <<<"$payload")
  if [ "$got" = "null" ] || [ -z "$got" ]; then
    echo "smoke-queue: missing $path in response: $payload" >&2
    exit 1
  fi
  printf '%s' "$got"
}

# Helper: POST JSON and emit the response body.
post_json () {
  local path="$1"
  local body="$2"
  shift 2
  curl -sS -X POST "$BASE_URL$path" \
    -H 'content-type: application/json' \
    "$@" \
    --data-binary "$body"
}

echo "smoke-queue: 1/5 issue ticket"
issue_response=$(post_json /api/v1/tickets '{
  "nameKana": "ヤマダ タロウ",
  "phoneLast4": "1234",
  "freeText": null
}')
ticket_id=$(require_jq "$issue_response" '.ticket.id')
echo "  -> ticketId = $ticket_id"

echo "smoke-queue: 2/5 staff call-next"
call_response=$(post_json /api/v1/queue/call-next '{}' \
  -H "x-staff-token: $STAFF_TOKEN")
called_id=$(require_jq "$call_response" '.ticket.id')
called_state=$(require_jq "$call_response" '.ticket.state')
[ "$called_state" = "Called" ] || {
  echo "smoke-queue: expected state=Called, got $called_state" >&2
  exit 1
}
echo "  -> called $called_id ($called_state)"

echo "smoke-queue: 3/5 staff recall"
recall_response=$(post_json "/api/v1/tickets/$called_id/recall" '{}' \
  -H "x-staff-token: $STAFF_TOKEN")
recalled_state=$(require_jq "$recall_response" '.ticket.state')
[ "$recalled_state" = "Waiting" ] || {
  echo "smoke-queue: expected state=Waiting after recall, got $recalled_state" >&2
  exit 1
}
echo "  -> recalled (state=$recalled_state)"

echo "smoke-queue: 4/5 staff call-next (again)"
call2_response=$(post_json /api/v1/queue/call-next '{}' \
  -H "x-staff-token: $STAFF_TOKEN")
called2_state=$(require_jq "$call2_response" '.ticket.state')
[ "$called2_state" = "Called" ] || {
  echo "smoke-queue: expected state=Called after re-call, got $called2_state" >&2
  exit 1
}

echo "smoke-queue: 5/5 staff mark-served"
served_response=$(post_json "/api/v1/tickets/$called_id/served" '{}' \
  -H "x-staff-token: $STAFF_TOKEN")
served_state=$(require_jq "$served_response" '.ticket.state')
[ "$served_state" = "Served" ] || {
  echo "smoke-queue: expected state=Served, got $served_state" >&2
  exit 1
}
echo "  -> served"

echo "smoke-queue: OK ($ticket_id Issued -> Called -> Recalled -> Called -> Served)"
