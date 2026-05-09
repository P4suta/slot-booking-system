/**
 * Guard gates pass/fail capture — the lightweight regex / grep
 * gates (pii, domain-purity, strict-code, dead-code,
 * type-coverage, error-docs-drift) are not amenable to per-file
 * JSON aggregation, so the diagnose surface only records whether
 * they passed.
 */
import { writeFileSync } from "node:fs"
import { exec } from "../lib/exec.js"
import type { GateReport } from "./types.js"

type GuardName =
  | "pii-guard"
  | "domain-purity"
  | "strict-code"
  | "dead-code"
  | "type-coverage"
  | "error-docs-drift"

const GUARDS: readonly { readonly name: GuardName; readonly recipe: string }[] = [
  { name: "pii-guard", recipe: "pii-guard" },
  { name: "domain-purity", recipe: "domain-purity" },
  { name: "strict-code", recipe: "strict-code" },
  { name: "dead-code", recipe: "dead-code" },
  { name: "type-coverage", recipe: "type-coverage" },
  { name: "error-docs-drift", recipe: "error-docs-drift-check" },
]

type GuardResult = {
  readonly name: GuardName
  readonly status: "PASS" | "FAIL"
  readonly hits: number
}

const runOne = async (guard: (typeof GUARDS)[number]): Promise<GuardResult> => {
  const result = await exec("just", [guard.recipe])
  const log = `${result.stdout}\n${result.stderr}`
  writeFileSync(`.diagnose/guards-${guard.name}.log`, log)
  if (result.code === 0) {
    writeFileSync(`.diagnose/guards-${guard.name}.status`, "PASS:0")
    return { name: guard.name, status: "PASS", hits: 0 }
  }
  const hits = log.split("\n").filter((line) => line.length > 0).length
  writeFileSync(`.diagnose/guards-${guard.name}.status`, `FAIL:${String(hits)}`)
  return { name: guard.name, status: "FAIL", hits }
}

export const runGuardsGate = async (): Promise<{
  readonly report: GateReport
  readonly guards: readonly GuardResult[]
}> => {
  const guards: GuardResult[] = []
  for (const g of GUARDS) {
    process.stdout.write(`→ ${g.name}\n`)
    const r = await runOne(g)
    guards.push(r)
    process.stdout.write(
      `  ${g.name}: ${r.status}${r.status === "FAIL" ? ` (${String(r.hits)} log lines)` : ""}\n`,
    )
  }
  const failed = guards.filter((g) => g.status === "FAIL")
  const lines: string[] = []
  lines.push("## guards")
  lines.push("")
  for (const g of guards) {
    if (g.status === "PASS") {
      lines.push(`  - **${g.name}**: PASS`)
    } else {
      lines.push(`  - **${g.name}**: FAIL (${String(g.hits)})`)
    }
  }
  return {
    report: {
      name: "guards",
      label: "guards",
      status: failed.length === 0 ? "PASS" : "FAIL",
      count: failed.length,
      detail: lines.join("\n"),
    },
    guards,
  }
}
