#!/usr/bin/env bash
# End-to-end smoke for the slot-booking reservation surface
# (ADR-0066 / ADR-0067 / ADR-0068). Intended to run against
# `wrangler dev` (default port 8787). The script chains:
#
#   1. issue a walk-in ticket  (lane omitted)
#   2. list slots              (GET /api/v1/slots)
#   3. issue a reservation     (lane=reservation, near-future apptAt)
#   4. check-in                (POST /api/v1/tickets/:id/check-in)
#   5. CallNext                (EDF eligible reservation should win)
#   6. MarkServed              (close the cycle)
#
# Exit non-zero on any HTTP failure or unexpected envelope shape;
# stdout summarises each step for human reading.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
STAFF_TOKEN="${STAFF_SESSION_SECRET:-dev-placeholder-replace-in-prod}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

require_jq () {
  local payload="$1" path="$2" got
  got=$(jq -r "$path" <<<"$payload")
  if [ "$got" = "null" ] || [ -z "$got" ]; then
    echo "smoke-reservation: missing $path in response: $payload" >&2
    exit 1
  fi
  printf '%s' "$got"
}

post_json () {
  local path="$1" body="$2"
  shift 2
  curl -sS -X POST "$BASE_URL$path" \
    -H 'content-type: application/json' \
    "$@" --data-binary "$body"
}

echo "smoke-reservation: 1/6 issue walk-in"
walk_in=$(post_json /api/v1/tickets '{
  "nameKana": "ヤマダ タロウ",
  "phoneLast4": "1234",
  "freeText": null
}')
walk_id=$(require_jq "$walk_in" '.ticket.id')
echo "  -> walk-in ticketId = $walk_id"

echo "smoke-reservation: 2/6 list slots"
today=$(date -u +%Y-%m-%d)
day_after=$(date -u -d '+2 days' +%Y-%m-%d 2>/dev/null || date -u -v+2d +%Y-%m-%d)
slots=$(curl -sS "$BASE_URL/api/v1/slots?from=$today&to=$day_after&granularity=30")
slot_count=$(jq '.slots | length' <<<"$slots")
echo "  -> $slot_count buckets returned"

# Pick a slot that is ~5min in the future so EDF + check-in window
# both engage. The next-30-min bucket from now satisfies both.
appt_iso=$(date -u -d '+6 minutes' +%Y-%m-%dT%H:%M:00Z 2>/dev/null \
  || date -u -v+6M +%Y-%m-%dT%H:%M:00Z)
echo "smoke-reservation: 3/6 issue reservation at $appt_iso"
reservation=$(post_json /api/v1/tickets "{
  \"nameKana\": \"スズキ ジロウ\",
  \"phoneLast4\": \"5678\",
  \"freeText\": null,
  \"lane\": \"reservation\",
  \"appointmentAt\": \"$appt_iso\"
}")
res_id=$(require_jq "$reservation" '.ticket.id')
appt_back=$(require_jq "$reservation" '.ticket.appointmentAt')
echo "  -> reservation ticketId = $res_id (apptAt = $appt_back)"

echo "smoke-reservation: 4/6 check-in"
checkin=$(post_json "/api/v1/tickets/$res_id/check-in" '')
ok=$(require_jq "$checkin" '.ok')
echo "  -> check-in ok = $ok"

echo "smoke-reservation: 5/6 CallNext (EDF should pick the reservation)"
called=$(post_json /api/v1/queue/call-next '{}' \
  -H "x-staff-token: $STAFF_TOKEN")
called_id=$(require_jq "$called" '.ticket.id')
called_lane=$(require_jq "$called" '.ticket.lane')
echo "  -> called id=$called_id lane=$called_lane"
if [ "$called_id" != "$res_id" ]; then
  echo "smoke-reservation: EDF did not promote the reservation (called=$called_id, expected=$res_id)" >&2
  exit 1
fi

echo "smoke-reservation: 6/6 MarkServed"
served=$(post_json "/api/v1/tickets/$res_id/served" '' \
  -H "x-staff-token: $STAFF_TOKEN")
served_state=$(require_jq "$served" '.ticket.state')
echo "  -> served state = $served_state"

echo "smoke-reservation: ALL OK"
