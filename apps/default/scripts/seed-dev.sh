#!/usr/bin/env bash
# Populate a fresh `wrangler dev` instance with a realistic mix of
# tickets across all four staff-dashboard columns:
#
#   - 待機 (Waiting): walk-ins + reservations
#   - 呼び出し中 (Called): a couple of tickets the staff already pulled
#   - 対応中 (Serving): one ticket the staff started servicing
#   - 履歴 (terminal): a Served, a Cancelled, a NoShow
#
# Run after `just dev-up` (or `just dev-default`). For a fully
# clean slate the wrapper `just dev-seed` first restarts wrangler
# dev with a wiped state directory.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
STAFF_TOKEN="${STAFF_SESSION_SECRET:-dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

post_json () {
  local path="$1"
  local body="$2"
  shift 2
  curl -sS -X POST "$BASE_URL$path" \
    -H 'content-type: application/json' \
    "$@" \
    --data-binary "$body"
}

# Wait for wrangler to be ready (max ~20s) — the script is often
# invoked immediately after a server restart.
echo "seed: waiting for wrangler dev on $BASE_URL ..."
for _ in $(seq 1 40); do
  if curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/v1/queue" 2>/dev/null | grep -q '^200$'; then
    break
  fi
  sleep 0.5
done

issue_walkin () {
  local kana="$1"; local last4="$2"; local note="$3"
  local body
  body=$(jq -n --arg k "$kana" --arg p "$last4" --arg n "$note" \
    '{nameKana:$k, phoneLast4:$p, freeText: ($n | select(length>0) // null)}')
  post_json /api/v1/tickets "$body" | jq -r '.ticket.id'
}

issue_reservation () {
  local kana="$1"; local last4="$2"; local at="$3"; local note="$4"
  local body
  body=$(jq -n --arg k "$kana" --arg p "$last4" --arg t "$at" --arg n "$note" \
    '{nameKana:$k, phoneLast4:$p, freeText: ($n | select(length>0) // null), lane:"reservation", appointmentAt:$t}')
  post_json /api/v1/tickets "$body" | jq -r '.ticket.id'
}

issue_priority () {
  local kana="$1"; local last4="$2"; local note="$3"
  local body
  body=$(jq -n --arg k "$kana" --arg p "$last4" --arg n "$note" \
    '{nameKana:$k, phoneLast4:$p, freeText: ($n | select(length>0) // null), lane:"priority"}')
  post_json /api/v1/tickets "$body" | jq -r '.ticket.id'
}

staff_call () {
  local id="$1"
  post_json /api/v1/queue/call-specific "{\"ticketId\":\"$id\"}" \
    -H "x-staff-token: $STAFF_TOKEN" >/dev/null
}

staff_start_serving () {
  local id="$1"
  post_json "/api/v1/tickets/$id/start-serving" '{}' \
    -H "x-staff-token: $STAFF_TOKEN" >/dev/null
}

staff_served () {
  local id="$1"
  post_json "/api/v1/tickets/$id/served" '{}' \
    -H "x-staff-token: $STAFF_TOKEN" >/dev/null
}

staff_no_show () {
  local id="$1"
  post_json "/api/v1/tickets/$id/no-show" '{}' \
    -H "x-staff-token: $STAFF_TOKEN" >/dev/null
}

staff_cancel () {
  local id="$1"
  post_json "/api/v1/tickets/$id/cancel" '{"reason":"seed-dev"}' \
    -H "x-staff-token: $STAFF_TOKEN" >/dev/null
}

today=$(date -u +%Y-%m-%d)

echo "seed: 履歴 — 1 件 Served"
served_id=$(issue_walkin "ナガノ ハルカ" "1001" "")
staff_call "$served_id"
staff_start_serving "$served_id"
staff_served "$served_id"

echo "seed: 履歴 — 1 件 Cancelled"
cancelled_id=$(issue_walkin "アライ ユウタ" "1002" "")
staff_cancel "$cancelled_id"

echo "seed: 履歴 — 1 件 NoShow"
noshow_id=$(issue_walkin "オカモト ミナミ" "1003" "")
staff_call "$noshow_id"
staff_no_show "$noshow_id"

echo "seed: 対応中 — 1 件"
serving_id=$(issue_walkin "ヤマモト ケンジ" "2001" "肩こりの相談")
staff_call "$serving_id"
staff_start_serving "$serving_id"

echo "seed: 呼び出し中 — 2 件"
called_a=$(issue_walkin "イノウエ サトミ" "3001" "")
called_b=$(issue_reservation "コバヤシ ユウキ" "3002" "${today}T05:00:00.000Z" "予約あり")
staff_call "$called_a"
staff_call "$called_b"

echo "seed: 待機 — 6 件 (walk-in / 予約 / 優先 を混在)"
issue_walkin "アオキ リョウ"   "4001" "" >/dev/null
issue_walkin "ナカムラ ユイ"   "4002" "色見本を確認したい" >/dev/null
issue_reservation "イトウ シンジ" "4003" "${today}T07:00:00.000Z" "" >/dev/null
issue_priority "タカハシ サクラ" "4004" "車椅子で来店" >/dev/null
issue_walkin "シミズ ナナミ" "4005" "" >/dev/null
issue_reservation "ハシモト カズキ" "4006" "${today}T09:30:00.000Z" "" >/dev/null

echo "seed: done."
echo "      管理画面: http://localhost:5173/staff"
echo "      お客様画面: http://localhost:5173/"
echo "      staff token: $STAFF_TOKEN"
