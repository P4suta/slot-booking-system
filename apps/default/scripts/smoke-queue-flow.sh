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

echo "smoke-queue: 1/6 issue ticket"
issue_response=$(post_json /api/v1/tickets '{
  "nameKana": "ヤマダ タロウ",
  "phoneLast4": "1234",
  "freeText": null
}')
ticket_id=$(require_jq "$issue_response" '.ticket.id')
echo "  -> ticketId = $ticket_id"

echo "smoke-queue: 1b/6 recover by-handle (ADR-0069)"
by_handle_response=$(curl -sS --get "$BASE_URL/api/v1/tickets/by-handle" \
  --data-urlencode "nameKana=ヤマダ タロウ" \
  --data-urlencode "phoneLast4=1234")
by_handle_id=$(require_jq "$by_handle_response" '.ticket.id')
[ "$by_handle_id" = "$ticket_id" ] || {
  echo "smoke-queue: expected by-handle to return $ticket_id, got $by_handle_id" >&2
  exit 1
}
echo "  -> by-handle returned $by_handle_id"

echo "smoke-queue: 2/6 staff call-specific (target our handle's ticket)"
call_response=$(post_json /api/v1/queue/call-specific "{\"ticketId\":\"$ticket_id\"}" \
  -H "x-staff-token: $STAFF_TOKEN")
called_id=$(require_jq "$call_response" '.ticket.id')
called_state=$(require_jq "$call_response" '.ticket.state')
[ "$called_id" = "$ticket_id" ] || {
  echo "smoke-queue: expected call-specific to call $ticket_id, got $called_id" >&2
  exit 1
}
[ "$called_state" = "Called" ] || {
  echo "smoke-queue: expected state=Called, got $called_state" >&2
  exit 1
}
echo "  -> called $called_id ($called_state)"

echo "smoke-queue: 3/6 staff recall"
recall_response=$(post_json "/api/v1/tickets/$ticket_id/recall" '{}' \
  -H "x-staff-token: $STAFF_TOKEN")
recalled_state=$(require_jq "$recall_response" '.ticket.state')
[ "$recalled_state" = "Waiting" ] || {
  echo "smoke-queue: expected state=Waiting after recall, got $recalled_state" >&2
  exit 1
}
echo "  -> recalled (state=$recalled_state)"

echo "smoke-queue: 4/6 staff call-specific (again)"
call2_response=$(post_json /api/v1/queue/call-specific "{\"ticketId\":\"$ticket_id\"}" \
  -H "x-staff-token: $STAFF_TOKEN")
called2_state=$(require_jq "$call2_response" '.ticket.state')
[ "$called2_state" = "Called" ] || {
  echo "smoke-queue: expected state=Called after re-call, got $called2_state" >&2
  exit 1
}

echo "smoke-queue: 5/6 staff mark-served"
served_response=$(post_json "/api/v1/tickets/$ticket_id/served" '{}' \
  -H "x-staff-token: $STAFF_TOKEN")
served_state=$(require_jq "$served_response" '.ticket.state')
[ "$served_state" = "Served" ] || {
  echo "smoke-queue: expected state=Served, got $served_state" >&2
  exit 1
}
echo "  -> served"

echo "smoke-queue: 6/6 by-handle after Served (handle released)"
released_response=$(curl -sS -o /dev/null -w '%{http_code}' --get "$BASE_URL/api/v1/tickets/by-handle" \
  --data-urlencode "nameKana=ヤマダ タロウ" \
  --data-urlencode "phoneLast4=1234")
[ "$released_response" = "404" ] || {
  echo "smoke-queue: expected 404 after handle release, got $released_response" >&2
  exit 1
}
echo "  -> handle released (404)"

echo "smoke-queue: OK ($ticket_id Issued -> Called -> Recalled -> Called -> Served, handle released)"
