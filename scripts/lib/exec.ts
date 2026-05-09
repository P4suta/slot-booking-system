/**
 * Thin process-exec helpers used by the diagnose suite. Every
 * command goes through `bash scripts/dev-exec.sh` so the actual
 * tooling (tsc, biome, eslint, depcruise, jq, rg) keeps running
 * inside the dev container — only orchestration / parsing /
 * aggregation lives on the host.
 */
import { spawn } from "node:child_process"

export type ExecResult = {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

export const exec = (
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<ExecResult> =>
  new Promise<ExecResult>((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env === undefined ? process.env : { ...process.env, ...env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("exit", (code) => {
      resolve({ stdout, stderr, code })
    })
  })

export const devExec = (args: readonly string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> =>
  exec("bash", ["scripts/dev-exec.sh", ...args], env)
