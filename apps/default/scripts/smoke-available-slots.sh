#!/usr/bin/env bash
# Smoke test for the `availableSlots` query.
#
# Preconditions (the recipe documentation in `just smoke-available-slots`
# also lists these):
#   1. `just migrate-local` has applied the catalog schema to the
#      local D1 fixture.
#   2. `just seed` has populated the catalog with the demo entities.
#   3. `just dev-default` is running in a separate terminal — wrangler
#      serves on http://localhost:8787 by default.
#
# The script POSTs a tiny GraphQL query, asserts a 200 response and
# the presence of the `availableSlots` field in the JSON body, then
# exits non-zero on any failure. There is no schema-shape assertion
# beyond presence — Phase 0.10's Miniflare integration test owns the
# round-trip parity check.

set -euo pipefail

ENDPOINT="${SMOKE_GRAPHQL_ENDPOINT:-http://localhost:8787/graphql}"
SERVICE_ID="${SMOKE_SERVICE_ID:-serv_demo0000000000000000000001}"
DATE="${SMOKE_DATE:-2026-05-11}"

read -r -d '' PAYLOAD <<JSON || true
{
  "query": "query Smoke(\$serviceId: String!, \$date: PlainDate!) { availableSlots(serviceId: \$serviceId, date: \$date) { serviceId start end providerId resourceIds } }",
  "variables": { "serviceId": "${SERVICE_ID}", "date": "${DATE}" }
}
JSON

response=$(curl --silent --show-error --fail --max-time 15 \
  -H "content-type: application/json" \
  --data-raw "${PAYLOAD}" \
  "${ENDPOINT}")

if ! grep -q "availableSlots" <<<"${response}"; then
  echo "smoke: response does not contain 'availableSlots' field" >&2
  echo "smoke: response was: ${response}" >&2
  exit 1
fi

echo "smoke: ${ENDPOINT} returned an availableSlots payload"
echo "${response}"
