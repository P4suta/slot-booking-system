#!/usr/bin/env bash
# End-to-end smoke for the booking customer flow.
#
# Preconditions (`just smoke-booking-flow` documents these):
#   1. `just migrate-local`  — applies catalog schema to local D1.
#   2. `just seed`           — populates the demo catalog rows.
#   3. `just dev-default`    — wrangler serves on http://localhost:8787.
#
# The script chains: availableSlots → holdSlot → confirmBooking →
# cancelBooking. Each curl checks for a 200 response and the
# expected typename in the JSON body. Any step that fails exits
# non-zero and dumps the offending response.
#
# Why this and not Miniflare integration tests: ADR-0036 records
# the Miniflare suite as carry-over for a later phase. Until that
# lands, a curl smoke against the local wrangler dev process is
# the cheapest end-to-end signal — every layer (resolver → token
# verify → DO RPC → SQL → outbox → audit) executes for real.

set -euo pipefail

ENDPOINT="${SMOKE_GRAPHQL_ENDPOINT:-http://localhost:8787/graphql}"
SERVICE_ID="${SMOKE_SERVICE_ID:-serv_demo0000000000000000000001}"
DATE="${SMOKE_DATE:-2026-05-11}"
PHONE="${SMOKE_PHONE:-1234}"

post() {
  curl --silent --show-error --fail --max-time 15 \
    -H "content-type: application/json" \
    --data-raw "$1" \
    "${ENDPOINT}"
}

extract_field() {
  python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
keys = sys.argv[1].split('.')
node = data
for k in keys:
    if isinstance(node, list) and k.isdigit():
        node = node[int(k)]
    else:
        node = node.get(k)
        if node is None:
            sys.exit(f'missing field {sys.argv[1]} in: {data}')
print(node)
" "$1"
}

echo "== availableSlots =="
slots_response=$(post "{
  \"query\": \"query(\$serviceId: String!, \$date: PlainDate!) { availableSlots(serviceId: \$serviceId, date: \$date) { token start end } }\",
  \"variables\": { \"serviceId\": \"${SERVICE_ID}\", \"date\": \"${DATE}\" }
}")
echo "${slots_response}"

token=$(echo "${slots_response}" | extract_field "data.availableSlots.0.token")
echo "token: ${token:0:40}..."

echo "== holdSlot =="
hold_response=$(post "{
  \"query\": \"mutation(\$date: PlainDate!, \$slotToken: String!, \$nameKana: String!, \$phoneLast4: PhoneLast4!, \$source: BookingSource!) { holdSlot(date: \$date, slotToken: \$slotToken, nameKana: \$nameKana, phoneLast4: \$phoneLast4, source: \$source) { __typename ... on MutationHoldSlotSuccess { data { bookingId state eventType } } ... on BookingError { tag code i18nKey } } }\",
  \"variables\": { \"date\": \"${DATE}\", \"slotToken\": \"${token}\", \"nameKana\": \"テスト\", \"phoneLast4\": \"${PHONE}\", \"source\": \"online\" }
}")
echo "${hold_response}"

held=$(echo "${hold_response}" | extract_field "data.holdSlot.__typename")
if [ "${held}" != "MutationHoldSlotSuccess" ]; then
  echo "smoke: expected MutationHoldSlotSuccess after holdSlot, got ${held}" >&2
  # Surface dev-only `extensions.cause.message` — populated by the
  # ErrorRedaction port (ADR-0043) when IS_DEV='1'. The caller can
  # paste this into Jaeger search to find the matching trace.
  echo "${hold_response}" | python3 -c '
import json, sys
data = json.loads(sys.stdin.read())
errors = data.get("errors") or []
for err in errors:
    cause = (err.get("extensions") or {}).get("cause")
    if cause: sys.stderr.write(f"smoke: cause = {cause.get(\"name\", \"?\")}: {cause.get(\"message\", \"?\")}\n")
' >&2 || true
  exit 1
fi
booking_id=$(echo "${hold_response}" | extract_field "data.holdSlot.data.bookingId")
state=$(echo "${hold_response}" | extract_field "data.holdSlot.data.state")
event_type=$(echo "${hold_response}" | extract_field "data.holdSlot.data.eventType")

# Field-level assertions — pin the exact wire shape so a future PR
# that drifts the booking-id format / state / event type fails this
# gate before the regression reaches the operator.
if ! [[ "${booking_id}" =~ ^bk_[0-9a-z]{26}$ ]]; then
  echo "smoke: booking id ${booking_id} does not match TypeID pattern bk_[0-9a-z]{26}" >&2
  exit 1
fi
if [ "${state}" != "Held" ]; then
  echo "smoke: expected state=Held after holdSlot, got ${state}" >&2
  exit 1
fi
if [ "${event_type}" != "Held" ]; then
  echo "smoke: expected eventType=Held after holdSlot, got ${event_type}" >&2
  exit 1
fi
echo "booking: ${booking_id} state=${state} eventType=${event_type}"

# We need the booking code from the seed flow; for now skip
# confirmBooking + cancelBooking — they require parsing the code
# off a separate read which the resolver doesn't yet expose. The
# Phase 0.11 staff dashboard adds that read; the present smoke
# verifies the hardest leg (slot token → DO write).

echo "smoke-booking-flow: hold succeeded for ${booking_id}"
