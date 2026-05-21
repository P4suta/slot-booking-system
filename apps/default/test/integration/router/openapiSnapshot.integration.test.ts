import { reset } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { worker } from "../_harness/httpFixture.js"
import * as req from "../_harness/sample-requests.js"

/**
 * Golden snapshot for the `/api/v1/openapi.json` document
 * (ADR-0078 Step 2).
 *
 * Pins three properties simultaneously so a regression in any
 * one of them fails the gate:
 *
 *   1. Every router-served path appears in the document. Adding
 *      a route requires registering its path here (and in the
 *      hand-written `openapi.ts`).
 *   2. Every request-body / query schema is derived from
 *      `boundaryRegistry` — checked by asserting the body of
 *      `POST /tickets` (the canonical derived case) carries
 *      `additionalProperties: false` (the Effect.Schema default
 *      that no hand-written entry would have set).
 *   3. The shared `components.schemas` slot holds the union of
 *      `$defs` produced by the registry — `Instant` is the
 *      sentinel because `IssueTicketBody.appointmentAt` /
 *      `RescheduleBody.newAppointmentAt` both reference it.
 */

afterEach(async () => {
  await reset()
})

type OpenApiDoc = {
  readonly openapi: string
  readonly info: { readonly title: string; readonly version: string }
  readonly paths: Record<string, Record<string, unknown>>
  readonly components?: { readonly schemas?: Record<string, unknown> }
}

const fetchOpenApi = async (): Promise<OpenApiDoc> => {
  const res = await worker().fetch(req.openApiDocument())
  expect(res.status).toBe(200)
  const body: OpenApiDoc = await res.json()
  return body
}

describe("openapi.json (ADR-0078 Step 2)", () => {
  it("declares OpenAPI 3.1 with the queue REST title", async () => {
    const doc = await fetchOpenApi()
    expect(doc.openapi).toBe("3.1.0")
    expect(doc.info.title).toContain("queue REST API")
  })

  it("covers every router-served path", async () => {
    const doc = await fetchOpenApi()
    const expectedPaths = [
      "/tickets",
      "/tickets/{id}/check-in",
      "/slots",
      "/tickets/by-handle",
      "/tickets/{id}/cancel",
      "/tickets/{id}/push-subscription",
      "/tickets/{id}/reschedule",
      "/tickets/{id}/served",
      "/tickets/{id}/no-show",
      "/tickets/{id}/recall",
      "/queue",
      "/queue/call-next",
      "/queue/feed",
      "/staff/login",
      "/openapi.json",
    ]
    for (const path of expectedPaths) {
      expect(doc.paths[path], `missing path ${path}`).toBeDefined()
    }
  })

  it("request bodies are derived (POST /tickets carries Schema defaults)", async () => {
    const doc = await fetchOpenApi()
    const ticketsPost = doc.paths["/tickets"]?.post as
      | {
          readonly requestBody?: {
            readonly content?: {
              readonly "application/json"?: {
                readonly schema?: {
                  readonly additionalProperties?: unknown
                  readonly type?: string
                }
              }
            }
          }
        }
      | undefined
    const issueBody = ticketsPost?.requestBody?.content?.["application/json"]?.schema
    expect(issueBody).toBeDefined()
    expect(issueBody?.type).toBe("object")
    // Hand-written body schemas in the pre-derive openapi.ts did not
    // emit `additionalProperties: false`; the derived form
    // (`Schema.Struct` → `additionalProperties: false`) does. This
    // assertion is the gate that catches a regression that swaps a
    // derived body for an inline hand-written one.
    expect(issueBody?.additionalProperties).toBe(false)
  })

  it("`components.schemas` contains the shared $defs entries", async () => {
    const doc = await fetchOpenApi()
    const schemas = doc.components?.schemas
    expect(schemas).toBeDefined()
    // `Instant` is referenced by `IssueTicketBody.appointmentAt` and
    // `RescheduleBody.newAppointmentAt`; the OpenAPI 3.1 conversion
    // (`JsonSchema.toMultiDocumentOpenApi3_1`) lifts every `$defs`
    // entry into `components.schemas` and rewrites refs to
    // `#/components/schemas/...`. If a future Schema change drops
    // this shared definition the assertion still passes (the doc
    // emits no `Instant` key at all), so we additionally pin the
    // presence of *some* shared schema entry.
    expect(Object.keys(schemas ?? {}).length).toBeGreaterThanOrEqual(1)
    expect(schemas?.Instant).toBeDefined()
  })
})
