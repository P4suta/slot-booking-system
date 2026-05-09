/**
 * ESLint deep-dive — `eslint . --format=json --max-warnings 0`
 * inside the container, aggregate messages by file + by rule id.
 */
import { devExec } from "../lib/exec.js"
import { type GateReport, renderTopList, topN, writeRawLog } from "./types.js"

type EslintFile = {
  readonly filePath: string
  readonly errorCount: number
  readonly warningCount: number
  readonly messages?: readonly { readonly ruleId: string | null }[]
}

const safeParse = (raw: string): readonly EslintFile[] => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as readonly EslintFile[]
  } catch {
    return []
  }
}

export const runEslintGate = async (): Promise<GateReport> => {
  const result = await devExec([
    "./node_modules/.bin/eslint",
    ".",
    "--format=json",
    "--max-warnings",
    "0",
  ])
  writeRawLog("eslint", result.stdout)
  const files = safeParse(result.stdout)

  const errors = files.reduce((acc, f) => acc + f.errorCount, 0)
  const warnings = files.reduce((acc, f) => acc + f.warningCount, 0)
  const total = errors + warnings
  const status = result.code === 0 ? "PASS" : "FAIL"

  const noisyFiles = files.filter((f) => f.errorCount + f.warningCount > 0).map((f) => f.filePath)
  const ruleIds = files.flatMap((f) => (f.messages ?? []).map((m) => m.ruleId ?? "no-rule"))

  const lines: string[] = []
  lines.push("## eslint")
  lines.push("")
  lines.push(
    `Status: **${status}** (exit ${String(result.code)}, errors ${String(errors)}, warnings ${String(warnings)})`,
  )
  lines.push("")
  if (total === 0) {
    lines.push("_no diagnostics_")
  } else {
    lines.push("### top files")
    lines.push("")
    lines.push(renderTopList(topN(noisyFiles)))
    lines.push("")
    lines.push("### top rules")
    lines.push("")
    lines.push(renderTopList(topN(ruleIds)))
  }
  return { name: "eslint", label: "eslint", status, count: total, detail: lines.join("\n") }
}
