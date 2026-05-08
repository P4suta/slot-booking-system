import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildOpenAPISpec } from "../src/server/rest/openapiSpec.js"

/**
 * Phase 3 / PR#8 M23 — OpenAPI 3.1 SDL emission.
 *
 * `apps/default/src/server/rest/openapiSpec.ts` builds the spec from
 * Effect Schema declarations through the M21
 * `schemaToOpenAPISchema` functor. This script materialises the
 * spec to a repo-tracked artefact so:
 *
 * 1. Wire-format diffs surface in pull requests (the diff between
 *    runs of `gen:api-spec` exposes Schema changes that affect the
 *    REST surface).
 * 2. Downstream consumers (operator tooling, future SDK generation)
 *    have a stable on-disk reference without booting the Worker.
 *
 * Output: `apps/default/openapi/openapi.json`. CI / pre-push runs
 * the script and a follow-up `git diff --quiet` gate to reject
 * stale artefacts.
 */

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, "..", "openapi")
const outFile = resolve(outDir, "openapi.json")

mkdirSync(outDir, { recursive: true })
const spec = buildOpenAPISpec()
writeFileSync(outFile, `${JSON.stringify(spec, null, 2)}\n`, "utf8")
// biome-ignore lint/suspicious/noConsole: codegen script logs progress to stdout
console.info(`[gen-api-spec] wrote OpenAPI 3.1 spec to ${outFile}`)
