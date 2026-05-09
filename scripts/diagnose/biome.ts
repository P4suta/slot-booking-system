/**
 * Biome lint deep-dive — `biome check --reporter=json` inside the
 * container, then aggregate diagnostics by file + by category.
 * The reporter labels itself "unstable" but the summary block is
 * stable enough to drive the dashboard; a `effect/Schema` decode
 * here would be heavier than the gate deserves.
 */
import { devExec } from "../lib/exec.js"
import { type GateReport, renderTopList, topN, writeRawLog } from "./types.js"

type BiomeJson = {
  readonly summary?: {
    readonly errors?: number
    readonly warnings?: number
  }
  readonly diagnostics?: readonly {
    readonly category?: string
    readonly location?: { readonly path?: { readonly file?: string } }
  }[]
}

const safeParse = (raw: string): BiomeJson => {
  try {
    return JSON.parse(raw) as BiomeJson
  } catch {
    return {}
  }
}

export const runBiomeGate = async (): Promise<GateReport> => {
  const result = await devExec([
    "./node_modules/.bin/biome",
    "check",
    "--error-on-warnings",
    "--reporter=json",
    ".",
  ])
  writeRawLog("biome", result.stdout)
  const json = safeParse(result.stdout)

  const errors = json.summary?.errors ?? 0
  const warnings = json.summary?.warnings ?? 0
  const total = errors + warnings
  const status = result.code === 0 ? "PASS" : "FAIL"

  const files = (json.diagnostics ?? []).flatMap((d) =>
    d.location?.path?.file === undefined ? [] : [d.location.path.file],
  )
  const rules = (json.diagnostics ?? []).flatMap((d) =>
    d.category === undefined ? [] : [d.category],
  )

  const lines: string[] = []
  lines.push("## biome")
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
    lines.push(renderTopList(topN(files)))
    lines.push("")
    lines.push("### top rules")
    lines.push("")
    lines.push(renderTopList(topN(rules)))
  }
  return { name: "biome", label: "biome", status, count: total, detail: lines.join("\n") }
}
