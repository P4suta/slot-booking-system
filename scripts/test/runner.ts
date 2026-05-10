/**
 * Vitest workspace runner — TypeScript replacement for
 * `scripts/test-runner.sh`. Replaces the legacy shell wrapper's
 * `tail -F + grep` heuristics with event-driven consumption of the
 * `[stream] ...` lines emitted by `streamReporter.ts`, sharing the
 * same module namespace as the producer so the format spec is
 * type-checked across producer/consumer.
 *
 * Behaviour mirrors the old shell wrapper:
 *
 *   1. spawn `corepack pnpm -F <filter> exec vitest run --reporter=verbose`
 *   2. line-buffer stdout, parse `[stream] ...` events, track
 *      in-flight cases in a `Map`
 *   3. heartbeat every `VITEST_HEARTBEAT_SEC` (default 5s) when
 *      progress stalls
 *   4. enforce `TEST_DEADLINE` (default 60s) via SIGTERM, then
 *      SIGKILL +10s
 *   5. classify the (code, signal, passed, failed) tuple through
 *      `classifyExit` — the pool-teardown-hang tolerance lives
 *      there as a pure branch
 *
 * Usage: `tsx scripts/test/runner.ts <pnpm-filter> [extra vitest args...]`
 */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { classifyExit } from "./lib/exit.js"
import { startHeartbeat } from "./lib/heartbeat.js"
import { parseStreamLine } from "./lib/streamEvents.js"

const args = process.argv.slice(2)
const filter = args[0]
if (filter === undefined || filter.length === 0) {
  process.stderr.write(`usage: tsx scripts/test/runner.ts <pnpm-filter> [extra vitest args...]\n`)
  process.exit(2)
}
const extra = args.slice(1)

const deadlineSec = Number(process.env.TEST_DEADLINE ?? "60")
const heartbeatSec = Number(process.env.VITEST_HEARTBEAT_SEC ?? "5")
const killAfterSec = 10

// ---------------------------------------------------------------------------
// State shared between line consumer + heartbeat
// ---------------------------------------------------------------------------

const inFlight = new Map<string, number>()
let lastCompleted: string | null = null
let passed = 0
let failed = 0
const runnerErr = 0
let progressTicks = 0
let lastProgressMs = Date.now()
// vitest-pool-workers spends up to ~10 s booting Miniflare between
// test files; the watchdog must outlast that gap or we cut off the
// next file before it starts. 30 s is comfortably above any
// observed boot pause and well below the deadline.
const IDLE_THRESHOLD_MS = 30_000

// ---------------------------------------------------------------------------
// Spawn vitest
// ---------------------------------------------------------------------------

// Reporters are configured in each workspace's `vitest.config.ts`
// (`["verbose", "../../scripts/test/streamReporter.ts"]`); not
// passing `--reporter` from the CLI lets that config win, so the
// streamReporter actually runs and our event consumer sees
// CASE_START / CASE_END lines instead of just verbose-only output.
const child = spawn("corepack", ["pnpm", "-F", filter, "exec", "vitest", "run", ...extra], {
  stdio: ["ignore", "pipe", "pipe"],
})

const rl = createInterface({ input: child.stdout })
rl.on("line", (line: string) => {
  process.stdout.write(`${line}\n`)

  const ev = parseStreamLine(line)
  if (ev === null) return

  switch (ev.kind) {
    case "CASE_START":
      inFlight.set(ev.id, Date.now())
      progressTicks += 1
      return
    case "CASE_END":
      inFlight.delete(ev.id)
      lastCompleted = ev.id
      progressTicks += 1
      if (ev.state === "passed") passed += 1
      else if (ev.state === "failed") failed += 1
      // skipped cases do not affect the runner's exit decision —
      // the per-case counter is intentionally not maintained;
      // RUN_END below carries the authoritative final tally.
      return
    case "RUN_END":
      // Authoritative final tally from the reporter — overrides
      // the running counters above (which can double-count when
      // streamReporter and the verbose reporter both emit a
      // backstop pattern for the same failure).
      passed = ev.passed
      failed = ev.failed
      return
    default:
      progressTicks += 1
  }
  // vitest-pool-workers 0.16 keeps Miniflare DO connections alive
  // past the last CASE_END, so the runner never hits RUN_END / exits
  // on its own. We track the wall clock of every progress event;
  // the idle watchdog below SIGTERMs the child once `inFlight` is
  // empty and the gap exceeds the idle window.
  lastProgressMs = Date.now()
})

child.stderr.pipe(process.stderr)

// ---------------------------------------------------------------------------
// Heartbeat + deadline
// ---------------------------------------------------------------------------

const heartbeat = startHeartbeat({
  filter,
  intervalMs: heartbeatSec * 1000,
  inFlight,
  lastCompleted: () => lastCompleted,
  progressCount: () => progressTicks,
})

const deadlineTimer = setTimeout(() => {
  process.stderr.write(
    `[test-runner] ${filter}: deadline ${String(deadlineSec)}s reached; sending SIGTERM\n`,
  )
  child.kill("SIGTERM")
}, deadlineSec * 1000)

// Idle watchdog: when the child stops emitting events (`inFlight`
// empty for ≥ IDLE_THRESHOLD_MS after at least one CASE_END), the
// vitest-pool-workers hang has begun. Send SIGTERM early so the
// runner does not waste the rest of the deadline window.
const idleWatchdog = setInterval(() => {
  if (progressTicks === 0 || inFlight.size > 0) return
  if (Date.now() - lastProgressMs < IDLE_THRESHOLD_MS) return
  process.stderr.write(
    `[test-runner] ${filter}: idle ${String(IDLE_THRESHOLD_MS / 1000)}s after last event (passed=${String(
      passed,
    )}, failed=${String(failed)}); early SIGTERM\n`,
  )
  child.kill("SIGTERM")
  clearInterval(idleWatchdog)
}, 2_000)

const hardKillTimer = setTimeout(
  () => {
    if (child.exitCode === null) {
      process.stderr.write(
        `[test-runner] ${filter}: kill-after ${String(killAfterSec)}s; SIGKILL\n`,
      )
      child.kill("SIGKILL")
    }
  },
  (deadlineSec + killAfterSec) * 1000,
)

// ---------------------------------------------------------------------------
// Exit classification
// ---------------------------------------------------------------------------

child.on("exit", (code, signal) => {
  clearTimeout(deadlineTimer)
  clearTimeout(hardKillTimer)
  clearInterval(idleWatchdog)
  heartbeat.stop()

  const decision = classifyExit({
    code,
    signal,
    passed,
    failed,
    runnerErr,
    filter,
  })
  if (decision.note !== undefined) {
    process.stderr.write(`[test-runner] ${decision.note}\n`)
  }
  process.exit(decision.exit)
})
