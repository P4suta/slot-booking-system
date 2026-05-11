// Pure helpers for slot picker bucket arithmetic and ISO instant
// encoding. Extracted from /issue inline so /ticket reschedule
// dialog can share them without re-implementing the bucket math.
//
// `slotInstantOf` emits a real UTC instant: a wall-clock pick of
// "2026-05-12 14:00 JST" becomes `2026-05-12T05:00:00.000Z`.
// The backend's `intervalOf(slot, "Asia/Tokyo")` produces the same
// instant from the slot's `(date, bucketId, granularity)` triple,
// so reservations and slot occupancy align under simple `===` ms
// comparison. See ADR-0066 §morphism + apps/web/src/lib/businessTz.ts.

import { BUSINESS_TZ_OFFSET_MIN } from "./businessTz.js"

export type DateIso = string // "YYYY-MM-DD"
export type Granularity = 15 | 30 | 60

export function todayIso(now: Date = new Date()): DateIso {
  return formatDate(now)
}

export function dateOffsetIso(days: number, now: Date = new Date()): DateIso {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  return formatDate(d)
}

function formatDate(d: Date): DateIso {
  const yyyy = String(d.getFullYear()).padStart(4, "0")
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

export function labelOfBucket(bucketId: number, granularity: Granularity): string {
  const minutes = bucketId * granularity
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0")
  const mm = String(minutes % 60).padStart(2, "0")
  return `${hh}:${mm}`
}

export function slotInstantOf(date: DateIso, bucketId: number, granularity: Granularity): string {
  // Wall-clock minutes-since-midnight in business TZ → corresponding
  // UTC instant. `Date.parse(date + Z)` anchors at the date's UTC
  // midnight, then we shift by `wall - tzOffset` minutes.
  const wallMinutes = bucketId * granularity
  const utcMinutes = wallMinutes - BUSINESS_TZ_OFFSET_MIN
  const ms = Date.parse(`${date}T00:00:00.000Z`) + utcMinutes * 60_000
  return new Date(ms).toISOString()
}

export type ParsedSlot = { readonly date: DateIso; readonly bucketId: number }

export function parseSlotInstant(
  iso: string | null | undefined,
  granularity: Granularity,
): ParsedSlot | null {
  if (iso === null || iso === undefined) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  // Translate UTC instant back to business-TZ wall-clock by adding
  // the offset, then read the date / hour / minute as if UTC.
  const wallMs = ms + BUSINESS_TZ_OFFSET_MIN * 60_000
  const d = new Date(wallMs)
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0")
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(d.getUTCDate()).padStart(2, "0")
  const date: DateIso = `${yyyy}-${mm}-${dd}`
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
  if (minutes % granularity !== 0) return null
  return { date, bucketId: minutes / granularity }
}

export type DateTab = { readonly iso: DateIso; readonly label: string }

export function defaultDateTabs(now: Date = new Date()): readonly DateTab[] {
  return [
    { iso: dateOffsetIso(0, now), label: "今日" },
    { iso: dateOffsetIso(1, now), label: "明日" },
    { iso: dateOffsetIso(2, now), label: "明後日" },
  ]
}
