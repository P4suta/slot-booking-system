// Pure helpers for slot picker bucket arithmetic and ISO instant
// encoding. Extracted from /issue inline so /ticket reschedule
// dialog can share them without re-implementing the bucket math.
//
// Note: the slot ISO encoding writes the local Y-M-D + H:M as if it
// were UTC (`...Z`). The backend's TZ-aware decoder (DEPLOYMENT_TIMEZONE)
// re-interprets that. See ADR-0066 §Trade-offs and Stage 12 backend.

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
  return `${date}T${labelOfBucket(bucketId, granularity)}:00.000Z`
}

export type ParsedSlot = { readonly date: DateIso; readonly bucketId: number }

export function parseSlotInstant(
  iso: string | null | undefined,
  granularity: Granularity,
): ParsedSlot | null {
  if (iso === null || iso === undefined) return null
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):/.exec(iso)
  if (m === null) return null
  const [, date, hh, mm] = m
  const minutes = Number(hh) * 60 + Number(mm)
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
