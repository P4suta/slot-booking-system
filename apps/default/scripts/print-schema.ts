import { writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { printSchema } from "graphql"
import { schema } from "../src/server/graphql/schema.js"

/**
 * Phase 3 / GraphQL SDL export. Pothos accumulates resolver
 * registrations through side-effect imports (`schema.ts` imports
 * each `resolvers/*.ts` for its side effect of attaching a field
 * to the shared builder), then `builder.toSchema()` materialises
 * the GraphQL.js schema document. `printSchema` turns that into
 * the SDL string the apps/web build consumes through `gql.tada`.
 *
 * Output target: `apps/default/schema.graphql` — a tracked file so
 * the frontend repo state is reproducible without booting the
 * worker. CI / pre-push runs this script before the apps/web
 * paraglide step so the SDL is fresh on every consumer build.
 */

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, "..", "schema.graphql")

const sdl = printSchema(schema)
writeFileSync(out, `${sdl}\n`, "utf8")
// biome-ignore lint/suspicious/noConsole: codegen script logs progress to stdout
console.info(`[print-schema] wrote ${sdl.length} chars to ${out}`)
