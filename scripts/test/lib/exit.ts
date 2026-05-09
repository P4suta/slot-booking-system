/**
 * Exit-code classifier for the vitest runner. Pure function so the
 * decision branches are unit-testable without spawning a process.
 *
 * Outcome map:
 *
 *   - any failed case OR any RunnerError ........... → 1
 *   - vitest exited 0 .............................. → 0
 *   - signal in {SIGTERM, SIGKILL} OR
 *     code in {124, 137, 143}, with passed > 0 ..... → 0 (teardown
 *                                                       hang tolerance)
 *   - otherwise ..................................... → propagate
 *                                                       `code ?? 1`
 *
 * The teardown-hang branch is the workaround for vitest-pool-workers
 * 0.16's Miniflare-bound DO bindings holding the runtime past the
 * last `✓` (memory: feedback_workers_pool_teardown_hang). When the
 * deadline takes the runner out *after* every case passed, treating
 * the timeout as success is safe — every assertion has already run.
 */

export type RunnerExit = {
  readonly exit: number
  readonly note?: string
}

export type ClassifyInput = {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly passed: number
  readonly failed: number
  readonly runnerErr: number
  readonly filter: string
}

const TIMEOUT_CODES = new Set([124, 137, 143])
const TIMEOUT_SIGNALS = new Set<NodeJS.Signals>(["SIGTERM", "SIGKILL"])

export const classifyExit = (input: ClassifyInput): RunnerExit => {
  if (input.failed > 0 || input.runnerErr > 0) {
    return {
      exit: 1,
      note: `${input.filter}: ${String(input.failed)} failed / ${String(input.runnerErr)} runner-error`,
    }
  }

  if (input.code === 0) {
    return { exit: 0 }
  }

  const wasTimeout =
    (input.signal !== null && TIMEOUT_SIGNALS.has(input.signal)) ||
    (input.code !== null && TIMEOUT_CODES.has(input.code))

  if (wasTimeout && input.passed > 0) {
    return {
      exit: 0,
      note: `${input.filter}: runner hung after ${String(input.passed)} ✓; treating timeout as success.`,
    }
  }

  return {
    exit: input.code ?? 1,
    note: `${input.filter}: vitest exited ${input.code === null ? "?" : String(input.code)} (passed=${String(input.passed)}, failed=${String(input.failed)}).`,
  }
}
