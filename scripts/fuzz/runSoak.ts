/**
 * Long-run fuzz soak — TypeScript replacement for
 * `scripts/fuzz/run-soak.sh`.
 *
 * Stage 1: core property tests run in-process (~1 ms / iteration);
 *          a 100k iteration sweep finishes in seconds.
 * Stage 2: integration property tests drive the HTTP + DO + D1
 *          stack through Miniflare; the vitest-pool-workers 0.16
 *          runner-exit hang is absorbed by the test-runner's
 *          deadline tolerance branch.
 *
 * `FC_NUM_RUNS` overrides per-property iteration count (default
 * 100_000); `vitest --test-timeout` scales with that count via the
 * `~5 ms / iter + 30 s baseline` heuristic calibrated against the
 * suite's slowest property (`log-pii @ ~470 ms / 1000 iters`).
 *
 * The orchestrator emits a 10 s heartbeat so an operator can tell
 * "deep soak in progress" from "stuck", and surfaces the wall
 * time plus iteration count in the final summary line. Exit code
 * mirrors the underlying vitest invocation: a counterexample that
 * shrinks to a falsifying input fails the pipeline loudly.
 */
import { type SpawnOptions, spawn } from "node:child_process"

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? "100000")
const TEST_TIMEOUT_MS = NUM_RUNS * 5 + 30_000

const stage = (
  label: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> =>
  new Promise<number>((resolve) => {
    process.stdout.write(`[fuzz] ${label}\n`)
    const opts: SpawnOptions = { stdio: "inherit", env: { ...process.env, ...env } }
    const child = spawn(command, args, opts)
    child.on("exit", (code, signal) => {
      if (code !== null) {
        resolve(code)
        return
      }
      // Convert signal-terminated to a non-zero number so the
      // caller's status check stays uniform.
      process.stdout.write(`[fuzz] ${label} terminated by signal ${signal ?? "?"}\n`)
      resolve(1)
    })
  })

const main = async (): Promise<number> => {
  process.stdout.write(
    `[fuzz] FC_NUM_RUNS=${String(NUM_RUNS)} testTimeout=${String(TEST_TIMEOUT_MS)}ms\n`,
  )
  process.stdout.write(
    `[fuzz] each property runs ${String(NUM_RUNS)} fast-check iterations; vitest verbose reporter prints one line per property as it completes.\n`,
  )

  const startedAt = Date.now()
  const elapsed = (): number => Math.round((Date.now() - startedAt) / 1000)

  const heartbeat = setInterval(() => {
    process.stderr.write(`[fuzz] still running… (${String(elapsed())}s elapsed)\n`)
  }, 10_000)

  // Stage 1 — core property tests (in-process domain + Effect).
  let status = await stage(
    "stage 1 / 2 — core property tests (packages/core)",
    "bash",
    [
      "scripts/dev-exec.sh",
      "corepack",
      "pnpm",
      "-F",
      "@booking/core",
      "exec",
      "vitest",
      "run",
      `--test-timeout=${String(TEST_TIMEOUT_MS)}`,
      "test/property",
    ],
    { FC_NUM_RUNS: String(NUM_RUNS) },
  )

  // Stage 2 — integration property tests behind the test runner's
  // deadline tolerance (the vitest-pool-workers 0.16 teardown hang
  // is the runner's job to absorb, not this orchestrator's).
  if (status === 0) {
    status = await stage(
      "stage 2 / 2 — integration property tests (apps/default workers project)",
      "bash",
      [
        "scripts/dev-exec.sh",
        "corepack",
        "pnpm",
        "exec",
        "tsx",
        "scripts/test/runner.ts",
        "default",
        `--test-timeout=${String(TEST_TIMEOUT_MS)}`,
        "test/integration/property",
      ],
      {
        FC_NUM_RUNS: String(NUM_RUNS),
        TEST_DEADLINE: "120",
      },
    )
  }

  clearInterval(heartbeat)

  const totalSec = elapsed()
  if (status === 0) {
    process.stdout.write(
      `[fuzz] ✓ all property assertions passed in ${String(totalSec)}s (${String(NUM_RUNS)} iterations / property)\n`,
    )
  } else {
    process.stderr.write(
      `[fuzz] ✗ failure detected after ${String(totalSec)}s (exit=${String(status)})\n`,
    )
  }
  return status
}

main().then(
  (code) => {
    process.exit(code)
  },
  (err: unknown) => {
    process.stderr.write(`[fuzz] orchestrator threw: ${String(err)}\n`)
    process.exit(2)
  },
)
