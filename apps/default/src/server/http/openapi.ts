/**
 * Hand-written OpenAPI 3.1 document for the queue REST surface.
 * The spec mirrors the Hono router endpoints + Effect-Schema
 * request bodies; future work derives this directly from the
 * Schema declarations (Union → `oneOf + discriminator`) so the
 * surface stays drift-free.
 *
 * The document is deliberately compact — schemas live inline so a
 * consumer can `curl /api/v1/openapi.json | jq` and get the full
 * picture without fanout into `$ref` resolution. Adding a route
 * is a three-line change: register it on the Hono app, add the
 * path entry below, append the request body schema.
 */
const ERROR_RESPONSE = {
  description: "Domain or validation error",
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["ok", "error"],
        properties: {
          ok: { const: false },
          error: {
            type: "object",
            required: ["_tag", "code"],
            properties: {
              _tag: { type: "string" },
              code: { type: "string" },
            },
            additionalProperties: true,
          },
        },
      },
    },
  },
} as const

const TICKET_SCHEMA = {
  type: "object",
  required: ["id", "seq", "state", "nameKana", "phoneLast4", "issuedAt"],
  properties: {
    id: { type: "string", pattern: "^tkt_[A-Za-z0-9]{8,}$" },
    seq: { type: "integer", minimum: 1 },
    state: { type: "string", enum: ["Waiting", "Called", "Served", "NoShow", "Cancelled"] },
    nameKana: { type: "string" },
    phoneLast4: { type: "string", pattern: "^[0-9]{4}$" },
    freeText: { type: ["string", "null"] },
    issuedAt: { type: "string", format: "date-time" },
    calledAt: { type: "string", format: "date-time" },
    servedAt: { type: "string", format: "date-time" },
    cancelledAt: { type: "string", format: "date-time" },
    markedAt: { type: "string", format: "date-time" },
  },
  additionalProperties: true,
} as const

const TICKET_ENVELOPE = {
  description: "Ticket envelope",
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["ok", "ticket"],
        properties: { ok: { const: true }, ticket: TICKET_SCHEMA },
      },
    },
  },
} as const

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "slot-booking-system queue REST API",
    version: "1.0.0",
    summary:
      "Customer takes a number, staff calls the next in line. " +
      "Anonymous handle (nameKana + phoneLast4) for self-service mutations; " +
      "the staff token gates the operate-queue surface.",
  },
  servers: [{ url: "/api/v1" }],
  tags: [
    { name: "customer", description: "Customer-facing endpoints" },
    { name: "staff", description: "Operator endpoints; require x-staff-token" },
    { name: "projection", description: "Read-side projection feeds" },
  ],
  paths: {
    "/tickets": {
      post: {
        tags: ["customer"],
        summary: "Issue a new ticket",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["nameKana", "phoneLast4", "freeText"],
                properties: {
                  nameKana: { type: "string" },
                  phoneLast4: { type: "string", pattern: "^[0-9]{4}$" },
                  freeText: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        responses: { "201": TICKET_ENVELOPE, "422": ERROR_RESPONSE, "429": ERROR_RESPONSE },
      },
    },
    "/tickets/me": {
      get: {
        tags: ["customer"],
        summary: "Customer self-fetch (handle in querystring)",
        parameters: [
          { in: "query", name: "ticketId", required: true, schema: { type: "string" } },
          { in: "query", name: "nameKana", required: true, schema: { type: "string" } },
          { in: "query", name: "phoneLast4", required: true, schema: { type: "string" } },
        ],
        responses: { "200": TICKET_ENVELOPE, "403": ERROR_RESPONSE, "404": ERROR_RESPONSE },
      },
    },
    "/tickets/{id}/cancel": {
      post: {
        tags: ["customer", "staff"],
        summary: "Cancel a ticket (customer with handle, or staff)",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    title: "CustomerCancel",
                    type: "object",
                    required: ["nameKana", "phoneLast4", "reason"],
                    properties: {
                      nameKana: { type: "string" },
                      phoneLast4: { type: "string" },
                      reason: { type: "string" },
                    },
                  },
                  {
                    title: "StaffCancel",
                    type: "object",
                    required: ["reason"],
                    properties: { reason: { type: "string" } },
                  },
                ],
              },
            },
          },
        },
        responses: {
          "200": TICKET_ENVELOPE,
          "403": ERROR_RESPONSE,
          "404": ERROR_RESPONSE,
          "409": ERROR_RESPONSE,
          "422": ERROR_RESPONSE,
        },
      },
    },
    "/tickets/{id}/served": {
      post: {
        tags: ["staff"],
        summary: "Staff: mark Called → Served",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        responses: {
          "200": TICKET_ENVELOPE,
          "401": ERROR_RESPONSE,
          "403": ERROR_RESPONSE,
          "404": ERROR_RESPONSE,
          "409": ERROR_RESPONSE,
        },
      },
    },
    "/tickets/{id}/no-show": {
      post: {
        tags: ["staff"],
        summary: "Staff: mark Called → NoShow",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        responses: {
          "200": TICKET_ENVELOPE,
          "401": ERROR_RESPONSE,
          "403": ERROR_RESPONSE,
          "404": ERROR_RESPONSE,
          "409": ERROR_RESPONSE,
        },
      },
    },
    "/tickets/{id}/recall": {
      post: {
        tags: ["staff"],
        summary: "Staff: recall (Called → Waiting, original seq preserved)",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        responses: {
          "200": TICKET_ENVELOPE,
          "401": ERROR_RESPONSE,
          "403": ERROR_RESPONSE,
          "404": ERROR_RESPONSE,
          "409": ERROR_RESPONSE,
        },
      },
    },
    "/queue": {
      get: {
        tags: ["projection"],
        summary: "Shop projection — staff sees PII, anonymous client sees seq only",
        responses: {
          "200": {
            description: "Projection envelope",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "waitingCount"],
                  properties: {
                    ok: { const: true },
                    waitingCount: { type: "integer", minimum: 0 },
                    serving: { oneOf: [{ type: "null" }, TICKET_SCHEMA] },
                    waitingPreview: { type: "array", items: TICKET_SCHEMA },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/queue/call-next": {
      post: {
        tags: ["staff"],
        summary: "Staff: call the next Waiting ticket",
        responses: {
          "200": TICKET_ENVELOPE,
          "401": ERROR_RESPONSE,
          "403": ERROR_RESPONSE,
          "409": ERROR_RESPONSE,
          "429": ERROR_RESPONSE,
        },
      },
    },
    "/queue/events": {
      get: {
        tags: ["projection"],
        summary: "SSE stream of the projection (2 s polling, 30 s cap)",
        responses: {
          "200": {
            description: "text/event-stream",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["projection"],
        summary: "This OpenAPI document",
        responses: {
          "200": {
            description: "OpenAPI 3.1 document",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
} as const
