import { type ChildProcess, spawn } from "node:child_process"

/**
 * Process-group helper for orchestrator-style scripts that need to
 * tear down a child *and its descendants* with a single signal.
 *
 * The legacy shell wrappers (`check-parallel.sh`, `run-gate.sh`)
 * used `setsid` to detach each gate into its own pgid, then sent
 * SIGTERM with a negative pid so the whole `just <gate> →
 * dev-exec.sh → docker exec → vitest` tree went down together.
 * The TS port preserves that semantic via `detached: true`
 * (Node spawns the child as the leader of a new process group)
 * and `process.kill(-pgid, sig)` for the take-down.
 *
 * The wrapper exposes:
 *   - `spawnGroupLeader` — start the child as a pgid leader
 *   - `killGroup`        — best-effort signal to the whole group;
 *                          falls back to single-pid kill when the
 *                          group lookup fails (already-exited)
 */

export type GroupLeader = ChildProcess & { readonly pid: number }

export const spawnGroupLeader = (
  command: string,
  args: readonly string[],
  options: { readonly stdio?: "pipe" | "ignore" | ["ignore", "pipe", "pipe"] } = {},
): GroupLeader => {
  const child = spawn(command, args, {
    detached: true,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  })
  if (child.pid === undefined) {
    throw new Error(`spawnGroupLeader: spawn returned no pid for ${command}`)
  }
  return child as GroupLeader
}

export const killGroup = (leader: GroupLeader, signal: NodeJS.Signals): void => {
  try {
    process.kill(-leader.pid, signal)
  } catch {
    try {
      leader.kill(signal)
    } catch {
      // Already dead — both branches already returned the wrong
      // error; the caller does not care which one fired first.
    }
  }
}
