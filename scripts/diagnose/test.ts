/**
 * Vitest deep-dive — runs the runner per workspace with the JSON
 * reporter, aggregates failed test paths. The vitest-pool-workers
 * 0.16 teardown hang for `apps/default` is absorbed by the same
 * deadline tolerance the regular test runner uses.
 */
import { devExec, type ExecResult } from "../lib/exec.js"
import { type GateReport, writeRawLog } from "./types.js"

type VitestJsonResult = {
  readonly numFailedTests?: number
  readonly testResults?: readonly {
    readonly status?: string
    readonly name?: string
  }[]
}

const safeParse = (raw: string): VitestJsonResult => {
  // The runner streams `[stream] ...` lines mixed in with the JSON
  // reporter output; extract the first balanced JSON object on a
  // line whose first non-space char is `{`.
  for (const line of raw.split("\n")) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith("{")) continue
    try {
      return JSON.parse(trimmed) as VitestJsonResult
    } catch {}
  }
  return {}
}

const runWorkspace = async (
  filter: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly result: ExecResult; readonly parsed: VitestJsonResult }> => {
  const result = await devExec(
    [
      "corepack",
      "pnpm",
      "exec",
      "tsx",
      "scripts/test/runner.ts",
      filter,
      "--reporter=json",
      "--silent",
    ],
    env,
  )
  return { result, parsed: safeParse(result.stdout) }
}

export const runTestGate = async (): Promise<GateReport> => {
  const [core, def, web] = await Promise.all([
    runWorkspace("@booking/core", {}),
    runWorkspace("default", { TEST_DEADLINE: "20" }),
    runWorkspace("web", {}),
  ])

  const log = [
    "=== packages/core ===",
    core.result.stdout,
    "=== apps/default ===",
    def.result.stdout,
    "=== apps/web ===",
    web.result.stdout,
  ].join("\n")
  writeRawLog("test", log)

  const coreFailed = core.parsed.numFailedTests ?? 0
  const defaultFailed = def.parsed.numFailedTests ?? 0
  const webFailed = web.parsed.numFailedTests ?? 0
  const total = coreFailed + defaultFailed + webFailed
  const status = total === 0 ? "PASS" : "FAIL"

  const failedNames = (parsed: VitestJsonResult): readonly string[] =>
    (parsed.testResults ?? [])
      .filter((t) => t.status !== undefined && t.status !== "passed")
      .flatMap((t) => (t.name === undefined ? [] : [t.name]))

  const lines: string[] = []
  lines.push("## test (vitest)")
  lines.push("")
  lines.push(`Status: **${status}** (${String(total)} failed tests across 3 workspaces)`)
  lines.push("")
  lines.push(`  - packages/core: ${String(coreFailed)} failed`)
  lines.push(`  - apps/default: ${String(defaultFailed)} failed`)
  lines.push(`  - apps/web: ${String(webFailed)} failed`)
  lines.push("")
  if (total > 0) {
    lines.push("### failed test paths")
    lines.push("")
    for (const name of [
      ...failedNames(core.parsed),
      ...failedNames(def.parsed),
      ...failedNames(web.parsed),
    ].slice(0, 30)) {
      lines.push(`  - ${name}`)
    }
  }
  return { name: "test", label: "test", status, count: total, detail: lines.join("\n") }
}
