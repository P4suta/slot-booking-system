/**
 * Heartbeat ticker for the test runner. Emits an alert line to
 * stderr every `intervalMs` when no progress has been made since
 * the last tick — operators see *which* test the runner stalled
 * on within the interval rather than waiting for the deadline.
 *
 * "No progress" is the negative space: an in-flight case that has
 * been running across two consecutive ticks, or no running case
 * but a stable `lastCompleted` (i.e. between cases the runner
 * went silent). When the picture changes between ticks we stay
 * quiet — chatter only matters when something is *not* moving.
 */

const fmtClock = (): string => new Date().toTimeString().slice(0, 8)

export type HeartbeatInput = {
  readonly filter: string
  readonly intervalMs: number
  /** Live mutable reference owned by the caller (vitest progress). */
  readonly inFlight: ReadonlyMap<string, number>
  /** Latest completed case id; null until first CASE_END. */
  readonly lastCompleted: () => string | null
  /** Test case throughput (running counter). */
  readonly progressCount: () => number
}

export type HeartbeatHandle = {
  readonly stop: () => void
}

export const startHeartbeat = (input: HeartbeatInput): HeartbeatHandle => {
  let prevSnapshot = ""
  let prevCount = -1

  const tick = (): void => {
    const inFlightKeys = [...input.inFlight.keys()]
    const oldest = inFlightKeys[0]
    const completed = input.lastCompleted()
    const count = input.progressCount()

    let snapshot = ""
    if (oldest !== undefined) {
      snapshot = `in-flight: ${oldest}`
    } else if (completed !== null) {
      snapshot = `last completed: ${completed}`
    }

    // Quiet when progress is being made (counter advanced) or no
    // events have arrived yet at all.
    if (snapshot === "" || count !== prevCount) {
      prevSnapshot = snapshot
      prevCount = count
      return
    }

    if (snapshot === prevSnapshot) {
      process.stderr.write(`[heartbeat ${fmtClock()}] ${input.filter}: ${snapshot}\n`)
    }
    prevSnapshot = snapshot
    prevCount = count
  }

  const handle = setInterval(tick, input.intervalMs)
  return {
    stop: (): void => {
      clearInterval(handle)
    },
  }
}
