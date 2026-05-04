import { Temporal } from "@js-temporal/polyfill"
import { Either } from "effect"
import { type DomainError, InvalidOpenWindowError } from "../errors/Errors.js"

/**
 * `[start, end)` half-open interval within a single civil day. Both
 * sides are `Temporal.PlainTime`. The same-day constraint means a
 * window cannot wrap across midnight; deployments that need an
 * overnight shift must split it into two windows on adjacent weekdays.
 */
export type OpenWindow = {
  readonly start: Temporal.PlainTime
  readonly end: Temporal.PlainTime
}

const cmp = (a: Temporal.PlainTime, b: Temporal.PlainTime): number =>
  Temporal.PlainTime.compare(a, b)

export const makeOpenWindow = (
  start: Temporal.PlainTime,
  end: Temporal.PlainTime,
): Either.Either<OpenWindow, DomainError> => {
  if (cmp(start, end) >= 0) {
    return Either.left(
      new InvalidOpenWindowError({ reason: "start must precede end (same-day, no wrap)" }),
    )
  }
  return Either.right({ start, end })
}

/** Number of whole minutes covered by the window. */
export const windowMinutes = (w: OpenWindow): number => {
  const startMin = w.start.hour * 60 + w.start.minute
  const endMin = w.end.hour * 60 + w.end.minute
  return endMin - startMin
}

/** Sort + merge overlapping windows; return canonical disjoint sorted list. */
export const canonicalize = (windows: readonly OpenWindow[]): readonly OpenWindow[] => {
  if (windows.length === 0) return []
  const sorted = [...windows].sort((a, b) => cmp(a.start, b.start))
  const out: OpenWindow[] = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && cmp(w.start, last.end) <= 0) {
      // overlap or touch — merge
      out[out.length - 1] = {
        start: last.start,
        end: cmp(w.end, last.end) > 0 ? w.end : last.end,
      }
    } else {
      out.push(w)
    }
  }
  return out
}
