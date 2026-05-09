/**
 * Multi-gate diagnostic surface — TypeScript replacement for
 * `scripts/diagnose.sh` + the per-gate sub-scripts.
 *
 * Runs every quality gate `just check` would, but with each gate
 * isolated so a failing one does not short-circuit the rest. Each
 * gate's status (PASS/FAIL + count) lands in `.diagnose/<gate>.status`
 * and the markdown detail in `.diagnose/<gate>-detail.md`. The
 * orchestrator concatenates everything into `.diagnose/last-run.md`
 * (summary table) and `.diagnose/last-run-detail.md` (per-gate
 * detail).
 *
 * Exit code is **always 0** — diagnose is a snapshot, not a gate.
 */
import { writeFileSync } from "node:fs"
import { runArchGate } from "./diagnose/arch.js"
import { runBiomeGate } from "./diagnose/biome.js"
import { runEslintGate } from "./diagnose/eslint.js"
import { runGuardsGate } from "./diagnose/guards.js"
import { runTestGate } from "./diagnose/test.js"
import { runTscGate } from "./diagnose/tsc.js"
import { type GateReport, writeGateOutputs } from "./diagnose/types.js"

const SUBCOMMANDS = ["tsc", "biome", "eslint", "arch", "test", "guards"] as const
type Subcommand = (typeof SUBCOMMANDS)[number]

const isSubcommand = (s: string): s is Subcommand => (SUBCOMMANDS as readonly string[]).includes(s)

const nowIso = (): string => new Date().toISOString().replace(/\.\d+Z$/, "Z")

const formatRow = (report: GateReport): string => {
  const top = "—" // The TS port intentionally drops the legacy
  // shell's "top files / rules in summary row" — operators look at
  // `.diagnose/<gate>-detail.md` for that. The summary is now the
  // signpost, not the dashboard.
  const label = report.label.padEnd(13)
  const status = report.status.padEnd(6)
  const count = String(report.count).padEnd(5)
  return `| ${label} | ${status} | ${count} | ${top} |`
}

const runStandalone = async (sub: Subcommand): Promise<void> => {
  if (sub === "tsc") {
    const r = await runTscGate()
    writeGateOutputs(r)
    process.stdout.write(`${r.detail}\n`)
    return
  }
  if (sub === "biome") {
    const r = await runBiomeGate()
    writeGateOutputs(r)
    process.stdout.write(`${r.detail}\n`)
    return
  }
  if (sub === "eslint") {
    const r = await runEslintGate()
    writeGateOutputs(r)
    process.stdout.write(`${r.detail}\n`)
    return
  }
  if (sub === "arch") {
    const r = await runArchGate()
    writeGateOutputs(r)
    process.stdout.write(`${r.detail}\n`)
    return
  }
  if (sub === "test") {
    const r = await runTestGate()
    writeGateOutputs(r)
    process.stdout.write(`${r.detail}\n`)
    return
  }
  // sub === "guards"
  const { report } = await runGuardsGate()
  writeGateOutputs(report)
  process.stdout.write(`${report.detail}\n`)
}

const main = async (): Promise<void> => {
  const arg = process.argv[2]
  if (arg !== undefined && isSubcommand(arg)) {
    await runStandalone(arg)
    return
  }

  process.stdout.write("→ typecheck\n")
  const tsc = await runTscGate()
  writeGateOutputs(tsc)

  process.stdout.write("→ biome\n")
  const biome = await runBiomeGate()
  writeGateOutputs(biome)

  process.stdout.write("→ eslint\n")
  const eslint = await runEslintGate()
  writeGateOutputs(eslint)

  process.stdout.write("→ arch\n")
  const arch = await runArchGate()
  writeGateOutputs(arch)

  process.stdout.write("→ test\n")
  const test = await runTestGate()
  writeGateOutputs(test)

  process.stdout.write("→ guards\n")
  const guardsResult = await runGuardsGate()
  writeGateOutputs(guardsResult.report)

  // ---- summary -----------------------------------------------------
  const summary: string[] = []
  summary.push("# diagnose summary")
  summary.push("")
  summary.push(`_Generated: ${nowIso()}_`)
  summary.push("")
  summary.push("| gate          | status | count | top files / rules |")
  summary.push("|---------------|--------|-------|-------------------|")
  for (const r of [tsc, biome, eslint, arch, test]) {
    summary.push(formatRow(r))
  }
  summary.push("")
  summary.push("### Guards (pass/fail only)")
  summary.push("")
  for (const g of guardsResult.guards) {
    if (g.status === "PASS") {
      summary.push(`  - ${g.name}: **PASS**`)
    } else {
      summary.push(`  - ${g.name}: **FAIL** (${String(g.hits)} log lines)`)
    }
  }
  summary.push("")
  summary.push("Detail: see `.diagnose/last-run-detail.md` for per-gate top files / rules.")
  const summaryText = summary.join("\n")
  writeFileSync(".diagnose/last-run.md", summaryText)
  process.stdout.write(`${summaryText}\n`)

  // ---- detail aggregation ------------------------------------------
  const detailParts: string[] = []
  detailParts.push("# diagnose detail")
  detailParts.push("")
  for (const r of [tsc, biome, eslint, arch, test, guardsResult.report]) {
    detailParts.push(r.detail)
    detailParts.push("")
  }
  writeFileSync(".diagnose/last-run-detail.md", detailParts.join("\n"))
}

main().then(
  () => {
    process.exit(0)
  },
  (err: unknown) => {
    process.stderr.write(`[diagnose] orchestrator threw: ${String(err)}\n`)
    // Diagnose is a snapshot — exit 0 even on internal failure to
    // honour the long-standing contract.
    process.exit(0)
  },
)
