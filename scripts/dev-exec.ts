#!/usr/bin/env -S tsx
/**
 * dev-exec — host-side TypeScript wrapper that runs `<argv>` inside
 * the long-running `dev` Docker Compose service.
 *
 *   1. Cache the dev container ID at `.cache/dev-cid` so subsequent
 *      calls bypass the (~100 ms) `docker compose` CLI altogether.
 *   2. If the cache is missing / stale (container not running),
 *      bring `compose up -d dev` and refresh the cache.
 *   3. Spawn `docker exec <cid> <argv>` and forward the inner exit
 *      code (or signal) verbatim — lefthook + Justfile rely on it.
 *
 * The host needs only `node` + `tsx` (mise-managed); `bash` is no
 * longer on the recipe path. One shebang, one toolchain.
 */
import { execSync, type SpawnSyncReturns, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const CIDFILE = ".cache/dev-cid"

/** Bring the `dev` service up and persist its container id. */
const ensureUp = (): string => {
  execSync("docker compose up -d dev", { stdio: ["ignore", "ignore", "inherit"] })
  const cid = execSync("docker compose ps -q dev", { encoding: "utf8" }).trim()
  if (cid.length === 0) {
    process.stderr.write("dev-exec: docker compose ps -q dev returned empty\n")
    process.exit(2)
  }
  mkdirSync(dirname(CIDFILE), { recursive: true })
  writeFileSync(CIDFILE, cid)
  return cid
}

/** True iff the cached container id is still in `running` state. */
const isRunning = (cid: string): boolean => {
  const result: SpawnSyncReturns<string> = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Running}}", cid],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  )
  return result.stdout.trim() === "true"
}

const cachedCid = (() => {
  try {
    return readFileSync(CIDFILE, "utf8").trim()
  } catch {
    return ""
  }
})()
const cid = cachedCid.length > 0 && isRunning(cachedCid) ? cachedCid : ensureUp()

const argv = process.argv.slice(2)
if (argv.length === 0) {
  process.stderr.write("dev-exec: missing command\nusage: dev-exec <cmd> [args...]\n")
  process.exit(2)
}
const result = spawnSync("docker", ["exec", cid, ...argv], { stdio: "inherit" })
if (result.signal !== null) {
  process.kill(process.pid, result.signal)
} else {
  process.exit(result.status ?? 1)
}
