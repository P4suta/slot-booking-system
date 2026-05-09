/**
 * dependency-cruiser (arch) deep-dive — JSON reporter inside the
 * container, aggregate violations by rule + by source file.
 */
import { devExec } from "../lib/exec.js"
import { type GateReport, renderTopList, topN, writeRawLog } from "./types.js"

type ArchJson = {
  readonly summary?: {
    readonly error?: number
    readonly warn?: number
    readonly violations?: readonly {
      readonly from?: string
      readonly rule?: { readonly name?: string }
    }[]
  }
}

const safeParse = (raw: string): ArchJson => {
  try {
    return JSON.parse(raw) as ArchJson
  } catch {
    return {}
  }
}

export const runArchGate = async (): Promise<GateReport> => {
  const result = await devExec([
    "./node_modules/.bin/depcruise",
    "--output-type=json",
    "--validate",
    ".dependency-cruiser.cjs",
    "packages/core/src",
    "apps",
  ])
  writeRawLog("arch", result.stdout)
  const json = safeParse(result.stdout)

  const errors = json.summary?.error ?? 0
  const warns = json.summary?.warn ?? 0
  const total = errors + warns
  const status = result.code === 0 ? "PASS" : "FAIL"
  const violations = json.summary?.violations ?? []

  const rules = violations.flatMap((v) => (v.rule?.name === undefined ? [] : [v.rule.name]))
  const sources = violations.flatMap((v) => (v.from === undefined ? [] : [v.from]))

  const lines: string[] = []
  lines.push("## arch (dependency-cruiser)")
  lines.push("")
  lines.push(
    `Status: **${status}** (exit ${String(result.code)}, errors ${String(errors)}, warns ${String(warns)})`,
  )
  lines.push("")
  if (total === 0) {
    lines.push("_no violations_")
  } else {
    lines.push("### top rules")
    lines.push("")
    lines.push(renderTopList(topN(rules)))
    lines.push("")
    lines.push("### top sources")
    lines.push("")
    lines.push(renderTopList(topN(sources)))
  }
  return { name: "arch", label: "arch", status, count: total, detail: lines.join("\n") }
}
