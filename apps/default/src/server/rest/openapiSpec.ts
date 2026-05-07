import { type OpenAPISchemaObject, schemaToOpenAPISchema } from "@booking/core"
import { Schema } from "effect"

/**
 * Schema for the `/healthz` response. Lifts to an OpenAPI 3.1
 * component schema via {@link schemaToOpenAPISchema} — the same
 * Schema declaration drives both the runtime decoder and the
 * spec emission.
 */
export const HealthResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
})

/**
 * Build the deployment's OpenAPI 3.1 specification from Effect
 * Schema declarations. The body is small today (`/healthz` only) —
 * future REST endpoints register their request / response schemas
 * the same way (Schema.Struct → component name → path operation).
 */
export const buildOpenAPISpec = (): {
  readonly openapi: string
  readonly info: { readonly title: string; readonly version: string }
  readonly paths: Record<string, unknown>
  readonly components: { readonly schemas: Record<string, OpenAPISchemaObject> }
} => {
  const registry = new Map<string, OpenAPISchemaObject>()
  const healthResponse = schemaToOpenAPISchema(HealthResponseSchema, {
    name: "HealthResponse",
    registry,
  })
  registry.set("HealthResponse", healthResponse)

  return {
    openapi: "3.1.0",
    info: {
      title: "slot-booking-system REST surface",
      version: "0.0.0",
    },
    paths: {
      "/healthz": {
        get: {
          summary: "Liveness probe",
          responses: {
            "200": {
              description: "Service is up.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HealthResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/openapi.json": {
        get: {
          summary: "Self-describing OpenAPI 3.1 spec.",
          responses: {
            "200": {
              description: "OpenAPI 3.1 spec body.",
            },
          },
        },
      },
    },
    components: {
      schemas: Object.fromEntries(registry.entries()),
    },
  }
}
