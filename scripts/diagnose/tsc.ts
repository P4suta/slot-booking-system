/**
 * Typecheck deep-dive — runs `tsc -b` inside the dev container,
 * aggregates `path:line:col - error TS####` lines on three axes:
 *   - top files (top 10)
 *   - error code distribution (top 10)
 *   - file × error-code pairs (top 10)
 *
 * The textual aggregation lives in TS instead of awk so the
 * regex-driven grouping is unit-testable should it ever need to
 * grow (no operator should be debugging awk field arithmetic
 * for a fresh tsc release).
 */
import { devExec } from "../lib/exec.js"
import { type GateReport, renderTopList, topN, writeRawLog } from "./types.js"

const ERROR_LINE_RE = /^(.+?)[(:](\d+)[,:](\d+)\)?:?\s*-?\s*error TS(\d+):/

type ParsedError = {
  readonly file: string
  readonly code: string
}

const parseTscOutput = (raw: string): readonly ParsedError[] => {
  const out: ParsedError[] = []
  for (const line of raw.split("\n")) {
    const m = ERROR_LINE_RE.exec(line)
    if (m === null) continue
    out.push({ file: m[1] ?? "?", code: `TS${m[4] ?? "?"}` })
  }
  return out
}

export const runTscGate = async (): Promise<GateReport> => {
  const result = await devExec(["./node_modules/.bin/tsc", "-b"])
  const log = `${result.stdout}\n${result.stderr}`
  writeRawLog("typecheck", log)

  const errors = parseTscOutput(log)
  const status = result.code === 0 ? "PASS" : "FAIL"
  const count = errors.length

  const lines: string[] = []
  lines.push("## typecheck")
  lines.push("")
  lines.push(`Status: **${status}** (exit ${String(result.code)}, ${String(count)} errors)`)
  lines.push("")
  if (count === 0) {
    lines.push("_no errors_")
  } else {
    lines.push("### top files (top 10)")
    lines.push("")
    lines.push(renderTopList(topN(errors.map((e) => e.file))))
    lines.push("")
    lines.push("### error code distribution (top 10)")
    lines.push("")
    lines.push(renderTopList(topN(errors.map((e) => e.code))))
    lines.push("")
    lines.push("### top error code × file (top 10 pairs)")
    lines.push("")
    lines.push(renderTopList(topN(errors.map((e) => `${e.file} ${e.code}`))))
  }
  return { name: "typecheck", label: "typecheck", status, count, detail: lines.join("\n") }
}
