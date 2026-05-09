/**
 * Shared types + small helpers for the diagnose suite. Each gate
 * module returns a `GateReport` that the orchestrator concatenates
 * into the markdown summary + detail files; the per-gate detail
 * markdown is also written individually for `just diagnose-<gate>`
 * standalone use.
 */
import { mkdirSync, writeFileSync } from "node:fs"

type GateStatus = "PASS" | "FAIL"

export type GateReport = {
  /** Gate identifier (matches the `.diagnose/<name>.status` file name). */
  readonly name: string
  /** Human label for the summary table (e.g. `"typecheck"`). */
  readonly label: string
  readonly status: GateStatus
  /** Total error / warning / failure count surfaced by the gate. */
  readonly count: number
  /** Markdown detail body (sections under `## <gate>`). */
  readonly detail: string
}

const DIAGNOSE_DIR = ".diagnose"

const ensureDir = (): void => {
  mkdirSync(DIAGNOSE_DIR, { recursive: true })
}

export const writeGateOutputs = (report: GateReport): void => {
  ensureDir()
  writeFileSync(`${DIAGNOSE_DIR}/${report.name}.status`, `${report.status}:${String(report.count)}`)
  writeFileSync(`${DIAGNOSE_DIR}/${report.name}-detail.md`, report.detail)
}

export const writeRawLog = (gate: string, body: string): void => {
  ensureDir()
  writeFileSync(`${DIAGNOSE_DIR}/${gate}.log`, body)
}

/**
 * Group + count a list of items, return the top-N by descending
 * frequency. Used by every gate's "top files" / "top rules" view.
 */
export const topN = <T extends string>(items: readonly T[], limit = 10): readonly [T, number][] => {
  const counts = new Map<T, number>()
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
}

export const renderTopList = (entries: readonly (readonly [string, number])[]): string =>
  entries.map(([key, count]) => `  - ${key} — ${String(count)}`).join("\n")
