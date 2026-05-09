/**
 * Multi-angle diagnose snapshot — adds three diagnose-first
 * dimensions on top of the standard 6-gate aggregator:
 *
 *   - skip-by-TODO-tag count: every `it.skip` / `it.todo`
 *     line under `packages/` + `apps/` (target 0)
 *   - error-tag coverage matrix: 17 registry tags vs the
 *     integration tests that assert each tag (target 17/17)
 *   - silent-failure residual: `.catch(() => null)` and
 *     non-JSON `console.error(...)` sites (target 0)
 *
 * Output: `.diagnose/multi-angle.md` — markdown table + detail
 * sections. Exit 0 always (snapshot, not a gate).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { devExec } from "../lib/exec.js"

const TAGS = [
  "InvalidPhoneLast4",
  "InvalidNameKana",
  "InvalidFreeText",
  "InvalidBusinessTimeZone",
  "InvalidEntityId",
  "MissingStaffCapability",
  "PhoneMismatch",
  "TicketNotFound",
  "QueueEmpty",
  "AlreadyCancelled",
  "AlreadyCompleted",
  "AlreadyNoShow",
  "InvalidStateTransition",
  "InsufficientCapability",
  "AggregateNotFound",
  "Concurrency",
  "Storage",
] as const

const isNonEmpty = (line: string): boolean => line.length > 0

const lineCount = (raw: string): number => raw.split("\n").filter(isNonEmpty).length

export const runMultiAngle = async (): Promise<void> => {
  // Run the underlying 6-gate diagnose first; we layer the three
  // dimensions on top of its output.
  await devExec(["corepack", "pnpm", "exec", "tsx", "scripts/diagnose.ts"])

  // ---- skip-by-TODO-tag count ----------------------------------
  const todoResult = await devExec([
    "rg",
    "--pcre2",
    "-n",
    "-t",
    "ts",
    "-e",
    "it\\.(skip|todo)\\(",
    "packages",
    "apps",
  ])
  const todoLines = todoResult.stdout
    .split("\n")
    .filter((line) => isNonEmpty(line) && !line.includes("node_modules"))
    .join("\n")
  const todoCount = lineCount(todoLines)

  // ---- error-tag coverage matrix -------------------------------
  const expectResult = await devExec([
    "rg",
    "-n",
    "--no-heading",
    'expect.*toBe.*"',
    "apps/default/test/integration",
  ])
  const covered = new Set<string>()
  for (const tag of TAGS) {
    if (expectResult.stdout.includes(`"${tag}"`)) covered.add(tag)
  }
  const missing = TAGS.filter((tag) => !covered.has(tag))

  // ---- silent-failure residual ---------------------------------
  const silentResult = await devExec([
    "rg",
    "-U",
    "--pcre2",
    "-n",
    "-t",
    "ts",
    "-e",
    "\\.catch\\(\\(\\)\\s*=>\\s*null\\)",
    "-e",
    "console\\.error\\((?![^)]*JSON\\.stringify)",
    "apps",
    "packages",
  ])
  const silentLines = silentResult.stdout
    .split("\n")
    .filter((line) => {
      if (!isNonEmpty(line)) return false
      if (line.includes("node_modules")) return false
      if (line.includes("silentJsonParse.integration.test.ts")) return false
      if (line.includes("WorkersLoggerLive.ts")) return false
      return true
    })
    .join("\n")
  const silentCount = lineCount(silentLines)

  // ---- write report --------------------------------------------
  const lines: string[] = []
  lines.push("# Multi-angle diagnose snapshot")
  lines.push("")
  lines.push(`_Generated: ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}_`)
  lines.push("")
  lines.push("## Headline (3 new dimensions)")
  lines.push("")
  lines.push("| dimension | value | target |")
  lines.push("| --- | --- | --- |")
  lines.push(`| skip-by-TODO-tag count | ${String(todoCount)} | 0 |`)
  lines.push(`| error-tag coverage | ${String(covered.size)} / ${String(TAGS.length)} | 17 / 17 |`)
  lines.push(`| silent-failure residual | ${String(silentCount)} | 0 |`)
  lines.push("")
  if (todoCount > 0) {
    lines.push("### skip-by-TODO-tag detail")
    lines.push("")
    lines.push("```")
    lines.push(todoLines)
    lines.push("```")
    lines.push("")
  }
  if (missing.length > 0) {
    lines.push("### error-tag uncovered (no integration test asserts these tags)")
    lines.push("")
    for (const tag of missing) {
      lines.push(`- ${tag}`)
    }
    lines.push("")
  }
  if (silentCount > 0) {
    lines.push("### silent-failure residual detail")
    lines.push("")
    lines.push("```")
    lines.push(silentLines)
    lines.push("```")
    lines.push("")
  }
  lines.push("## Underlying gate snapshot")
  lines.push("")
  if (existsSync(".diagnose/last-run.md")) {
    lines.push(readFileSync(".diagnose/last-run.md", "utf8"))
  }

  writeFileSync(".diagnose/multi-angle.md", lines.join("\n"))
  process.stdout.write("→ wrote .diagnose/multi-angle.md\n")
}

runMultiAngle().then(
  () => {
    process.exit(0)
  },
  (err: unknown) => {
    process.stderr.write(`[diagnose-multi-angle] orchestrator threw: ${String(err)}\n`)
    process.exit(0)
  },
)
