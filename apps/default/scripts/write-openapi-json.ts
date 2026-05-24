#!/usr/bin/env tsx
import { writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { openApiDocument } from "../src/server/http/openapi.js"

/**
 * ADR-0083 — write the live OpenAPI document to disk so downstream
 * consumers (apps/web codegen via `openapi-typescript`, external
 * API explorers, the audit trail) can read a stable artefact rather
 * than the runtime `GET /api/v1/openapi.json` endpoint.
 *
 * The script is pure: it imports `openApiDocument` (which is a
 * constant assembled from the boundary registry and the hand-
 * written path stanzas at module load), serialises it with stable
 * 2-space indentation, and writes to `docs/openapi.json` from the
 * repository root. Re-run after every change to `openapi.ts` or
 * `boundarySchemas.ts`; a CI check (`apps/default/test/server/http/
 * openapi-on-disk.test.ts`) catches drift.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "../../..")
const outPath = resolve(repoRoot, "docs/openapi.json")

const serialised = `${JSON.stringify(openApiDocument, null, 2)}\n`
writeFileSync(outPath, serialised, "utf8")
// biome-ignore lint/suspicious/noConsole: this is a CLI script — stdout is the wire.
console.log(`wrote ${outPath} (${serialised.length} bytes)`)
