/**
 * Parser for the line format emitted by `scripts/test/streamReporter.ts`.
 *
 * The reporter writes one ASCII line per lifecycle event:
 *
 *   [stream] <ISO time> RUN_START   specs=<n>
 *   [stream] <ISO time> MODULE_START <relpath>
 *   [stream] <ISO time> CASE_START   <relpath> :: <full_name>
 *   [stream] <ISO time> CASE_END     <relpath> :: <full_name> <state> <ms>ms
 *   [stream] <ISO time> MODULE_END   <relpath>
 *   [stream] <ISO time> RUN_END      passed=<p> failed=<f> skipped=<s>
 *
 * `parseStreamLine` returns a typed event for the runner's
 * heartbeat / exit-classifier to consume, or `null` for any
 * non-stream line (verbose output, stderr, …). The producer-side
 * (streamReporter.ts) and the consumer-side (this parser) share the
 * format spec — drift in either side surfaces as a typed parse
 * miss in the unit tests.
 */

type CaseState = "passed" | "failed" | "skipped"

export type StreamEvent =
  | { readonly kind: "RUN_START"; readonly specs: number }
  | { readonly kind: "MODULE_START"; readonly relpath: string }
  | { readonly kind: "MODULE_END"; readonly relpath: string }
  | { readonly kind: "CASE_START"; readonly id: string }
  | {
      readonly kind: "CASE_END"
      readonly id: string
      readonly state: CaseState
      readonly durMs: number
    }
  | {
      readonly kind: "RUN_END"
      readonly passed: number
      readonly failed: number
      readonly skipped: number
    }

const PREFIX = /^\[stream\] \d{2}:\d{2}:\d{2}\.\d{3} (.+)$/

const RUN_START = /^RUN_START\s+specs=(\d+)\s*$/
const MODULE_START = /^MODULE_START\s+(.+)\s*$/
const MODULE_END = /^MODULE_END\s+(.+)\s*$/
const CASE_START = /^CASE_START\s+(.+)\s*$/
const CASE_END = /^CASE_END\s+(.+) (passed|failed|skipped) (\d+)ms\s*$/
const RUN_END = /^RUN_END\s+passed=(\d+) failed=(\d+) skipped=(\d+)\s*$/

export const parseStreamLine = (line: string): StreamEvent | null => {
  const head = PREFIX.exec(line)
  if (head === null) return null
  const body = head[1] ?? ""

  const runStart = RUN_START.exec(body)
  if (runStart !== null) {
    return { kind: "RUN_START", specs: Number(runStart[1]) }
  }

  const moduleStart = MODULE_START.exec(body)
  if (moduleStart !== null) {
    return { kind: "MODULE_START", relpath: (moduleStart[1] ?? "").trim() }
  }

  const moduleEnd = MODULE_END.exec(body)
  if (moduleEnd !== null) {
    return { kind: "MODULE_END", relpath: (moduleEnd[1] ?? "").trim() }
  }

  const caseEnd = CASE_END.exec(body)
  if (caseEnd !== null) {
    const stateStr = caseEnd[2]
    if (stateStr !== "passed" && stateStr !== "failed" && stateStr !== "skipped") return null
    return {
      kind: "CASE_END",
      id: (caseEnd[1] ?? "").trim(),
      state: stateStr,
      durMs: Number(caseEnd[3]),
    }
  }

  const caseStart = CASE_START.exec(body)
  if (caseStart !== null) {
    return { kind: "CASE_START", id: (caseStart[1] ?? "").trim() }
  }

  const runEnd = RUN_END.exec(body)
  if (runEnd !== null) {
    return {
      kind: "RUN_END",
      passed: Number(runEnd[1]),
      failed: Number(runEnd[2]),
      skipped: Number(runEnd[3]),
    }
  }

  return null
}
