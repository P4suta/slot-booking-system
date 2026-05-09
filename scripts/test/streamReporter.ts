/**
 * Vitest 4 stream reporter — emits one machine-readable line per
 * test lifecycle event so an outer wrapper (e.g. `test-runner.sh`)
 * can heartbeat on the *currently running* case rather than
 * having to guess from the last completed `✓`. The `verbose`
 * reporter only prints **after** a case finishes, so a wrapper
 * that watches `✓` lines is structurally blind during the case
 * itself: a 30-second hang inside one test looks identical to a
 * 30-second silence between cases. The custom reporter closes
 * that gap by emitting a `CASE_START` line the moment the case
 * begins.
 *
 * Output format (each line begins with `[stream] `):
 *   `[stream] <ISO time> RUN_START   specs=<n>`
 *   `[stream] <ISO time> MODULE_START <relpath>`
 *   `[stream] <ISO time> CASE_START   <relpath> :: <full_name>`
 *   `[stream] <ISO time> CASE_END     <relpath> :: <full_name> <state> <ms>ms`
 *   `[stream] <ISO time> MODULE_END   <relpath>`
 *   `[stream] <ISO time> RUN_END      passed=<p> failed=<f> skipped=<s>`
 *
 * Lines are flushed unconditionally on every event; pair with
 * `stdbuf -oL` upstream so the wrapper sees them line-by-line.
 *
 * The default reporter still owns the human-friendly tree output;
 * this companion is purely for the wrapper's heartbeat consumer.
 */
import type { Reporter, TestCase, TestModule, TestSpecification } from "vitest/node"

const ts = (): string => new Date().toISOString().slice(11, 23)

const emit = (line: string): void => {
  process.stdout.write(`[stream] ${ts()} ${line}\n`)
}

const cwd = process.cwd()
const rel = (p: string | undefined | null): string => {
  if (p === undefined || p === null) return "?"
  return p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p
}

/**
 * Walk the parent chain to assemble `Suite > Suite > test name`.
 * Vitest 4 hangs sub-suites off `parent`; the root `TestModule`
 * itself is also a parent but its `name` is the file path which
 * we drop (the relpath is already in the prefix).
 */
const fullName = (testCase: TestCase): string => {
  const parts: string[] = []
  let node: unknown = testCase
  while (node !== null && node !== undefined) {
    const name = (node as { name?: unknown }).name
    if (typeof name === "string" && name.length > 0 && !name.endsWith(".ts")) {
      parts.unshift(name)
    }
    node = (node as { parent?: unknown }).parent
  }
  return parts.join(" > ")
}

class StreamReporter implements Reporter {
  onTestRunStart(specs: readonly TestSpecification[]): void {
    emit(`RUN_START specs=${String(specs.length)}`)
  }

  onTestModuleStart(module: TestModule): void {
    emit(`MODULE_START ${rel(module.moduleId)}`)
  }

  onTestModuleEnd(module: TestModule): void {
    emit(`MODULE_END   ${rel(module.moduleId)}`)
  }

  onTestCaseReady(testCase: TestCase): void {
    emit(`CASE_START ${rel(testCase.module.moduleId)} :: ${fullName(testCase)}`)
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result()
    const maybeDuration = (result as unknown as { duration?: unknown }).duration
    const dur = typeof maybeDuration === "number" ? maybeDuration : 0
    emit(
      `CASE_END   ${rel(testCase.module.moduleId)} :: ${fullName(testCase)} ${result.state} ${String(dur)}ms`,
    )
  }

  onTestRunEnd(modules: readonly TestModule[]): void {
    let passed = 0
    let failed = 0
    let skipped = 0
    for (const m of modules) {
      for (const tc of m.children.allTests()) {
        const state = tc.result().state
        if (state === "passed") passed += 1
        else if (state === "failed") failed += 1
        else if (state === "skipped") skipped += 1
      }
    }
    emit(`RUN_END passed=${String(passed)} failed=${String(failed)} skipped=${String(skipped)}`)
  }
}

export default StreamReporter
