#!/usr/bin/env bash
# Populate a fresh `wrangler dev` instance with a realistic load
# (~75 tickets) so the staff dashboard, customer landing, slot
# picker and lane sort can be exercised at production-shape scale.
#
# Layout:
#   - 今日:
#       履歴 (terminal)  — 7 Served + 4 Cancelled + 4 NoShow
#       対応中 (Serving) — 3 walk-in
#       呼び出し中       — 4 walk-in + 1 reservation
#       待機 walk-in     — 17
#       待機 priority    — 7
#       待機 reservation — 8 (spread 09:30 .. 16:00 JST)
#   - 明日 (today + 1):
#       reservation     — 10 (spread 09:00 .. 16:30 JST)
#   - 明後日 (today + 2):
#       reservation     — 8  (spread 09:00 .. 16:30 JST)
#   - 3 日後 (today + 3):
#       reservation     — 5  (spread 09:00 .. 16:30 JST)
#
# All appointmentAt instants are encoded as actual UTC for the
# corresponding JST wall-clock (JST = UTC+9, no DST), matching
# `slotInstantOf` on the customer side and `intervalOf` on the
# server. Run after `just dev-up` (or `just dev-default`); for a
# fully clean slate the wrapper `just dev-seed` first restarts
# wrangler dev with a wiped state directory.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
STAFF_TOKEN="${STAFF_SESSION_SECRET:-dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v jq   >/dev/null || { echo "jq is required" >&2; exit 1; }

post_json () {
  local path="$1"
  local body="$2"
  shift 2
  curl -sS -X POST "$BASE_URL$path" \
    -H 'content-type: application/json' \
    "$@" \
    --data-binary "$body"
}

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

# Today / +1 / +2 / +3 in JST. The seed runs on the dev host whose
# locale may not be JST; the explicit TZ keeps the date math aligned
# with the customer's wall-clock convention.
day0=$(TZ='Asia/Tokyo' date +%Y-%m-%d)
day1=$(TZ='Asia/Tokyo' date -d '+1 day' +%Y-%m-%d)
day2=$(TZ='Asia/Tokyo' date -d '+2 days' +%Y-%m-%d)
day3=$(TZ='Asia/Tokyo' date -d '+3 days' +%Y-%m-%d)

# Convert "JST HH:MM on yyyy-mm-dd" → actual UTC instant ISO. JST is
# UTC+9 with no DST, so the wall-clock simply shifts by 9 h. The
# bash `date -d` invocation does the heavy lifting.
jst_at () {
  local date="$1"; local hh="$2"; local mm="$3"
  TZ=UTC date -d "${date}T${hh}:${mm}:00+09:00" +'%Y-%m-%dT%H:%M:00.000Z'
}

# ---------------------------------------------------------------------------
# 履歴 (terminal) — 7 Served + 4 Cancelled + 4 NoShow on today
# ---------------------------------------------------------------------------
echo "seed: 履歴 — Served × 7"
for spec in \
  "ナガノ ハルカ|1001|" \
  "アライ ユウタ|1002|肩こりの相談" \
  "オカモト ミナミ|1003|" \
  "シミズ ナナミ|1004|頭皮ケアの希望" \
  "ヤマダ サキ|1005|" \
  "サトウ ジロウ|1006|" \
  "イトウ ハナコ|1007|"; do
  IFS='|' read -r kana last4 note <<< "$spec"
  id=$(issue_walkin "$kana" "$last4" "$note")
  staff_call "$id"
  staff_start_serving "$id"
  staff_served "$id"
done

echo "seed: 履歴 — Cancelled × 4"
for spec in \
  "コバヤシ ユウキ|1008|" \
  "タカハシ ケンタ|1009|" \
  "ワタナベ アヤ|1010|" \
  "ナカムラ ソウタ|1011|"; do
  IFS='|' read -r kana last4 note <<< "$spec"
  id=$(issue_walkin "$kana" "$last4" "$note")
  staff_cancel "$id"
done

echo "seed: 履歴 — NoShow × 4"
for spec in \
  "カトウ リョウ|1012|" \
  "ヨシダ アキラ|1013|" \
  "マツモト ノブ|1014|" \
  "ササキ サオリ|1015|"; do
  IFS='|' read -r kana last4 note <<< "$spec"
  id=$(issue_walkin "$kana" "$last4" "$note")
  staff_call "$id"
  staff_no_show "$id"
done

# ---------------------------------------------------------------------------
# 対応中 (Serving) — 3 walk-in, all on today
# ---------------------------------------------------------------------------
echo "seed: 対応中 — 3 件"
for spec in \
  "ヤマモト ケンジ|2001|肩こりの相談" \
  "イノウエ サクラ|2002|" \
  "アオキ ミサキ|2003|肌荒れの相談"; do
  IFS='|' read -r kana last4 note <<< "$spec"
  id=$(issue_walkin "$kana" "$last4" "$note")
  staff_call "$id"
  staff_start_serving "$id"
done

# ---------------------------------------------------------------------------
# 呼び出し中 (Called) — 4 walk-in + 1 reservation, today
# ---------------------------------------------------------------------------
echo "seed: 呼び出し中 — 5 件"
called_ids=()
called_ids+=("$(issue_walkin 'クドウ ナナミ' '3001' '')")
called_ids+=("$(issue_walkin 'ハシモト コウキ' '3002' '')")
called_ids+=("$(issue_walkin 'オクダ ユイ' '3003' '車椅子で来店')")
called_ids+=("$(issue_walkin 'オオタ アヤ' '3004' '')")
called_ids+=("$(issue_reservation 'シマザキ シンジ' '3005' "$(jst_at "$day0" 11 00)" '予約 11:00')")
for id in "${called_ids[@]}"; do
  staff_call "$id"
done

# ---------------------------------------------------------------------------
# 待機 walk-in — 17 件
# ---------------------------------------------------------------------------
echo "seed: 待機 walk-in — 17 件"
for spec in \
  "アオキ リョウ|4001|" \
  "ナカムラ ユイ|4002|色見本を確認したい" \
  "シミズ ナナミ|4005|" \
  "ヤノ ジロウ|4007|" \
  "オガワ サオリ|4008|" \
  "イシイ ノブ|4009|" \
  "ハヤシ ハナコ|4010|" \
  "ヤマグチ ケンタ|4011|" \
  "クドウ サキ|4012|" \
  "アライ ハルカ|4013|" \
  "ナガノ ソウタ|4014|" \
  "シマザキ アキラ|4015|" \
  "オクダ ミサキ|4016|" \
  "オオタ コウキ|4017|" \
  "オガワ ユウタ|4018|" \
  "ヤノ サクラ|4019|" \
  "イシイ ジロウ|4020|"; do
  IFS='|' read -r kana last4 note <<< "$spec"
  issue_walkin "$kana" "$last4" "$note" >/dev/null
done

# ---------------------------------------------------------------------------
# 待機 priority — 7 件
# ---------------------------------------------------------------------------
echo "seed: 待機 priority — 7 件"
for spec in \
  "タカハシ サクラ|5001|車椅子で来店" \
  "ヨシダ ハルカ|5002|妊婦さん" \
  "ササキ アヤ|5003|" \
  "ハヤシ ケンタ|5004|高齢のお客様" \
  "イノウエ ジロウ|5005|" \
  "ヤマダ コウキ|5006|車椅子で来店" \
  "ナカムラ ノブ|5007|"; do
  IFS='|' read -r kana last4 note <<< "$spec"
  issue_priority "$kana" "$last4" "$note" >/dev/null
done

# ---------------------------------------------------------------------------
# 待機 reservation — 今日の枠 (09:30, 10:30, 11:30, 12:00, 13:30,
# 14:00, 15:00, 16:00 JST × 8 件)
# ---------------------------------------------------------------------------
echo "seed: 待機 reservation 今日 — 8 件"
issue_reservation "ハシモト カズキ" "6001" "$(jst_at "$day0"  9 30)" "" >/dev/null
issue_reservation "イトウ シンジ"   "6002" "$(jst_at "$day0" 10 30)" "" >/dev/null
issue_reservation "シミズ ハナコ"   "6003" "$(jst_at "$day0" 11 30)" "" >/dev/null
issue_reservation "オクダ サオリ"   "6004" "$(jst_at "$day0" 12  0)" "" >/dev/null
issue_reservation "ヨシダ ケンタ"   "6005" "$(jst_at "$day0" 13 30)" "" >/dev/null
issue_reservation "アオキ ナナミ"   "6006" "$(jst_at "$day0" 14  0)" "" >/dev/null
issue_reservation "マツモト リョウ" "6007" "$(jst_at "$day0" 15  0)" "" >/dev/null
issue_reservation "ヤマモト ミナミ" "6008" "$(jst_at "$day0" 16  0)" "" >/dev/null

# ---------------------------------------------------------------------------
# 待機 reservation — 明日 (10 件 across 09:00 .. 16:30)
# ---------------------------------------------------------------------------
echo "seed: 待機 reservation 明日 — 10 件"
issue_reservation "ナガノ ハナコ"   "7001" "$(jst_at "$day1"  9  0)" "" >/dev/null
issue_reservation "クドウ アヤ"     "7002" "$(jst_at "$day1" 10  0)" "" >/dev/null
issue_reservation "オオタ ユイ"     "7003" "$(jst_at "$day1" 10  0)" "" >/dev/null
issue_reservation "イシイ ジロウ"   "7004" "$(jst_at "$day1" 11  0)" "" >/dev/null
issue_reservation "ハヤシ ソウタ"   "7005" "$(jst_at "$day1" 12 30)" "" >/dev/null
issue_reservation "シマザキ アキラ" "7006" "$(jst_at "$day1" 13  0)" "" >/dev/null
issue_reservation "ヤノ サクラ"     "7007" "$(jst_at "$day1" 14  0)" "" >/dev/null
issue_reservation "オガワ ノブ"     "7008" "$(jst_at "$day1" 14 30)" "" >/dev/null
issue_reservation "ヤマグチ ケンタ" "7009" "$(jst_at "$day1" 15 30)" "" >/dev/null
issue_reservation "アライ ミサキ"   "7010" "$(jst_at "$day1" 16 30)" "" >/dev/null

# ---------------------------------------------------------------------------
# 待機 reservation — 明後日 (8 件)
# ---------------------------------------------------------------------------
echo "seed: 待機 reservation 明後日 — 8 件"
issue_reservation "オカモト ハルカ" "8001" "$(jst_at "$day2"  9  0)" "" >/dev/null
issue_reservation "ナカムラ コウキ" "8002" "$(jst_at "$day2" 10 30)" "" >/dev/null
issue_reservation "コバヤシ サキ"   "8003" "$(jst_at "$day2" 11 30)" "" >/dev/null
issue_reservation "サトウ アヤ"     "8004" "$(jst_at "$day2" 13  0)" "" >/dev/null
issue_reservation "スズキ ジロウ"   "8005" "$(jst_at "$day2" 14  0)" "" >/dev/null
issue_reservation "タナカ ミナミ"   "8006" "$(jst_at "$day2" 14 30)" "" >/dev/null
issue_reservation "ワタナベ ノブ"   "8007" "$(jst_at "$day2" 15 30)" "" >/dev/null
issue_reservation "イノウエ ハナコ" "8008" "$(jst_at "$day2" 16 30)" "" >/dev/null

# ---------------------------------------------------------------------------
# 待機 reservation — 3 日後 (5 件)
# ---------------------------------------------------------------------------
echo "seed: 待機 reservation 3 日後 — 5 件"
issue_reservation "ヤマダ サクラ"   "9001" "$(jst_at "$day3"  9 30)" "" >/dev/null
issue_reservation "タカハシ ノブ"   "9002" "$(jst_at "$day3" 11  0)" "" >/dev/null
issue_reservation "ササキ ユイ"     "9003" "$(jst_at "$day3" 13  0)" "" >/dev/null
issue_reservation "ヨシダ ジロウ"   "9004" "$(jst_at "$day3" 14 30)" "" >/dev/null
issue_reservation "ヤマモト ハルカ" "9005" "$(jst_at "$day3" 16  0)" "" >/dev/null

echo
echo "seed: done — 75 tickets across $day0 / $day1 / $day2 / $day3"
echo "      管理画面: http://localhost:5173/staff"
echo "      お客様画面: http://localhost:5173/"
echo "      staff token: $STAFF_TOKEN"
