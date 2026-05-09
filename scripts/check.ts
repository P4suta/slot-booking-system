/**
 * Parallel gate orchestrator — TypeScript replacement for
 * `scripts/check-parallel.sh` + `scripts/run-gate.sh`.
 *
 * Each gate runs as its own process-group leader so a single
 * SIGTERM tears down the whole `just <gate> → dev-exec.sh → docker
 * exec → underlying tool` tree (no orphaned `docker exec`
 * processes). Per-gate timeouts mirror the shell wrapper's
 * `timeout --kill-after=10`: SIGTERM at the deadline, SIGKILL
 * 10 s later. On the first non-zero exit the orchestrator
 * fail-fasts the survivors so a busted gate does not have to wait
 * for its slow siblings to finish.
 *
 * Gate completion is detected via the spawned child's `exit`
 * event; unlike the shell `wait -n -p pid`, Node's event API has
 * no race between exit and reaping, so the diagnostic attribution
 * (which gate exited with which code) is straightforward.
 */

import { type GroupLeader, killGroup, spawnGroupLeader } from "./lib/processGroup.js"
import { sleep } from "./lib/sleep.js"

type Gate = {
  readonly name: string
  readonly timeoutSec: number
}

// Gate list mirrors `scripts/check-parallel.sh`'s GATES array. The
// `comment-bans` ordering is unchanged so the output of `just check`
// stays diff-stable for operators who scan the boot region.
const GATES: readonly Gate[] = [
  { name: "lint-biome", timeoutSec: 30 },
  { name: "lint-eslint", timeoutSec: 60 },
  { name: "markdownlint", timeoutSec: 30 },
  { name: "typecheck", timeoutSec: 60 },
  { name: "arch", timeoutSec: 30 },
  { name: "comment-bans", timeoutSec: 30 },
  { name: "strict-code", timeoutSec: 30 },
  { name: "dead-code", timeoutSec: 60 },
  { name: "type-coverage", timeoutSec: 60 },
  { name: "test-coverage", timeoutSec: 120 },
  { name: "size-limit-core", timeoutSec: 120 },
  { name: "error-docs-drift-check", timeoutSec: 60 },
]

type GateState = {
  readonly gate: Gate
  readonly leader: GroupLeader
  readonly logBuf: string[]
  readonly startedAtMs: number
  done: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  killedByUs: boolean
  deadlineTimer: NodeJS.Timeout
  hardKillTimer: NodeJS.Timeout
}

const elapsedSec = (sinceMs: number): number => Math.round((Date.now() - sinceMs) / 1000)

const printGateDone = (state: GateState): void => {
  const elapsed = elapsedSec(state.startedAtMs)
  const tag = state.killedByUs
    ? "killed by fail-fast"
    : `exit=${state.exitCode === null ? `signal:${state.signal ?? "?"}` : String(state.exitCode)}`
  process.stdout.write(`[done]  ${state.gate.name} (${String(elapsed)}s, ${tag})\n`)
  const log = state.logBuf.join("")
  if (log.length === 0) return
  for (const raw of log.split("\n")) {
    if (raw.length === 0) continue
    process.stdout.write(`        [${state.gate.name}] ${raw}\n`)
  }
}

const launchGate = (gate: Gate): GateState => {
  const leader = spawnGroupLeader("just", [gate.name])
  const logBuf: string[] = []

  leader.stdout?.on("data", (chunk: Buffer) => {
    logBuf.push(chunk.toString("utf8"))
  })
  leader.stderr?.on("data", (chunk: Buffer) => {
    logBuf.push(chunk.toString("utf8"))
  })

  const deadlineTimer = setTimeout(() => {
    if (!state.done) {
      logBuf.push(
        `\n[run-gate] ${gate.name}: timed out after ${String(gate.timeoutSec)}s (SIGTERM)\n`,
      )
      killGroup(leader, "SIGTERM")
    }
  }, gate.timeoutSec * 1000)

  const hardKillTimer = setTimeout(
    () => {
      if (!state.done) {
        logBuf.push(
          `\n[run-gate] ${gate.name}: force-killed after ${String(gate.timeoutSec)}s (SIGKILL)\n`,
        )
        killGroup(leader, "SIGKILL")
      }
    },
    (gate.timeoutSec + 10) * 1000,
  )

  const state: GateState = {
    gate,
    leader,
    logBuf,
    startedAtMs: Date.now(),
    done: false,
    exitCode: null,
    signal: null,
    killedByUs: false,
    deadlineTimer,
    hardKillTimer,
  }

  leader.on("exit", (code, signal) => {
    state.done = true
    state.exitCode = code
    state.signal = signal
    clearTimeout(state.deadlineTimer)
    clearTimeout(state.hardKillTimer)
  })

  process.stdout.write(`[start] ${gate.name} (timeout=${String(gate.timeoutSec)}s)\n`)
  return state
}

const main = async (): Promise<number> => {
  const sessionStartedMs = Date.now()

  process.stdout.write("[boot] dev-exec warmup ...\n")
  await new Promise<void>((resolve) => {
    const warmup = spawnGroupLeader("bash", ["scripts/dev-exec.sh", "true"], { stdio: "ignore" })
    warmup.on("exit", () => {
      resolve()
    })
  })
  process.stdout.write(`[boot] dev-exec ready (${String(elapsedSec(sessionStartedMs))}s)\n`)

  const states = new Map<string, GateState>()
  for (const gate of GATES) {
    states.set(gate.name, launchGate(gate))
  }

  const cleanup = (): void => {
    for (const [, state] of states) {
      if (!state.done) killGroup(state.leader, "SIGTERM")
      clearTimeout(state.deadlineTimer)
      clearTimeout(state.hardKillTimer)
    }
  }
  process.on("SIGINT", () => {
    cleanup()
    process.exit(130)
  })
  process.on("SIGTERM", () => {
    cleanup()
    process.exit(143)
  })

  const failed: string[] = []
  let failFastTriggered = false

  while (states.size > 0) {
    const ready: GateState[] = []
    for (const [, state] of states) {
      if (state.done) ready.push(state)
    }
    if (ready.length === 0) {
      await sleep(100)
      continue
    }
    for (const state of ready) {
      states.delete(state.gate.name)
      printGateDone(state)
      const code = state.exitCode
      const isFailure = !state.killedByUs && (code === null || code !== 0)
      if (!isFailure) continue

      const codeLabel = code === null ? `signal:${state.signal ?? "?"}` : `exit=${String(code)}`
      failed.push(`${state.gate.name}(${codeLabel})`)
      if (failFastTriggered) continue
      failFastTriggered = true

      const survivors = [...states.values()]
      if (survivors.length > 0) {
        process.stdout.write(
          `[abort] killing ${String(survivors.length)} siblings (fail-fast on ${state.gate.name})\n`,
        )
      }
      for (const surv of survivors) {
        surv.killedByUs = true
        killGroup(surv.leader, "SIGTERM")
      }
    }
  }

  const total = elapsedSec(sessionStartedMs)
  if (failed.length > 0) {
    process.stderr.write(`\n[check-parallel] ✗ failed in ${String(total)}s: ${failed.join(", ")}\n`)
    return 1
  }
  process.stdout.write(`\n[check-parallel] ✓ all gates green in ${String(total)}s\n`)
  return 0
}

main().then(
  (code) => {
    process.exit(code)
  },
  (err: unknown) => {
    process.stderr.write(`[check-parallel] orchestrator threw: ${String(err)}\n`)
    process.exit(2)
  },
)
