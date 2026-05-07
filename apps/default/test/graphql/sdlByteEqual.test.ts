import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { printSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { schema } from "../../src/server/graphql/schema.js"

/**
 * PR#7 M18+M19 — SDL byte-equality regression net.
 *
 * `apps/default/schema.graphql` is the gold artefact: the apps/web
 * `gql.tada` typegen at `apps/web/src/graphql-env.d.ts` is derived
 * from this file via the `@0no-co/graphqlsp` TypeScript plugin
 * (`apps/web/tsconfig.json#plugins`). Any drift in the SDL silently
 * shifts the generated types and breaks query call-site inference
 * inside the SvelteKit app.
 *
 * ADR-0041 acceptance criterion #3 demands the post-migration SDL be
 * byte-equal to the pre-migration gold. This test makes that
 * invariant load-bearing inside the standard `pnpm test` loop —
 * faster than the `pnpm print-schema && git diff` CI path, and
 * runnable locally without docker compose.
 *
 * After M18+M19, the live schema is built directly from raw graphql-js
 * (no Pothos CJS in the chain), so the test is hermetic — module-load
 * cross-realm corner cases that prevented the test in M17 dissolve.
 */

const here = dirname(fileURLToPath(import.meta.url))
const goldPath = resolve(here, "..", "..", "schema.graphql")

describe("SDL byte-equality — apps/default/schema.graphql", () => {
  it("printSchema(schema) + newline equals the tracked gold artefact", () => {
    const expected = readFileSync(goldPath, "utf8")
    const actual = `${printSchema(schema)}\n`
    expect(actual).toBe(expected)
  })
})
