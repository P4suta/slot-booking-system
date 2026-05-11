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
  required: ["id", "seq", "lane", "displaySeq", "state", "nameKana", "phoneLast4", "issuedAt"],
  properties: {
    id: { type: "string", pattern: "^tkt_[A-Za-z0-9]{8,}$" },
    seq: { type: "integer", minimum: 1 },
    lane: { type: "string", enum: ["walkIn", "priority", "reservation"] },
    displaySeq: { type: "integer", minimum: 1 },
    state: {
      type: "string",
      enum: ["Waiting", "Called", "Served", "NoShow", "Cancelled"],
    },
    nameKana: { type: "string" },
    phoneLast4: { type: "string", pattern: "^[0-9]{4}$" },
    freeText: { type: ["string", "null"] },
    issuedAt: { type: "string", format: "date-time" },
    calledAt: { type: "string", format: "date-time" },
    servingStartedAt: { type: "string", format: "date-time" },
    servedAt: { type: "string", format: "date-time" },
    cancelledAt: { type: "string", format: "date-time" },
    markedAt: { type: "string", format: "date-time" },
    appointmentAt: { type: ["string", "null"], format: "date-time" },
    checkedInAt: { type: ["string", "null"], format: "date-time" },
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
        summary: "Issue a new ticket (walk-in or reservation, ADR-0066/0068)",
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
                  lane: { type: "string", enum: ["walkIn", "priority", "reservation"] },
                  appointmentAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        responses: {
          "201": TICKET_ENVELOPE,
          "200": TICKET_ENVELOPE,
          "422": ERROR_RESPONSE,
          "429": ERROR_RESPONSE,
        },
      },
    },
    "/tickets/{id}/check-in": {
      post: {
        tags: ["customer"],
        summary: "Customer-side arrival audit (reservation only, ADR-0068)",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "CheckedIn event recorded",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok"],
                  properties: { ok: { const: true } },
                },
              },
            },
          },
          "404": ERROR_RESPONSE,
          "409": ERROR_RESPONSE,
          "422": ERROR_RESPONSE,
        },
      },
    },
    "/slots": {
      get: {
        tags: ["customer"],
        summary: "Slot grid availability for the customer's booking picker (ADR-0066/0068)",
        parameters: [
          { in: "query", name: "from", required: true, schema: { type: "string", format: "date" } },
          { in: "query", name: "to", required: true, schema: { type: "string", format: "date" } },
          {
            in: "query",
            name: "granularity",
            required: true,
            schema: { type: "integer", enum: [15, 30, 60] },
          },
        ],
        responses: {
          "200": {
            description: "Bucket grid with capacity / taken / available",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "slots"],
                  properties: {
                    ok: { const: true },
                    slots: {
                      type: "array",
                      items: {
                        type: "object",
                        required: [
                          "date",
                          "bucketId",
                          "granularity",
                          "capacity",
                          "taken",
                          "available",
                        ],
                        properties: {
                          date: { type: "string", format: "date" },
                          bucketId: { type: "integer", minimum: 0 },
                          granularity: { type: "integer", enum: [15, 30, 60] },
                          capacity: { type: "integer", minimum: 0 },
                          taken: { type: "integer", minimum: 0 },
                          available: { type: "integer", minimum: 0 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "422": ERROR_RESPONSE,
        },
      },
    },
    "/tickets/by-handle": {
      get: {
        tags: ["customer"],
        summary: "Customer recovery — look up the active ticket by handle (ADR-0069)",
        parameters: [
          { in: "query", name: "nameKana", required: true, schema: { type: "string" } },
          { in: "query", name: "phoneLast4", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": TICKET_ENVELOPE,
          "404": ERROR_RESPONSE,
          "422": ERROR_RESPONSE,
          "429": ERROR_RESPONSE,
        },
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
    "/tickets/{id}/reschedule": {
      post: {
        tags: ["customer", "staff"],
        summary: "Reschedule a reservation ticket (atomic appointmentAt swap)",
        description:
          "ADR-0070. Same ticketId / seq / displaySeq / handle / lane stay; " +
          "only `appointmentAt` is replaced. Customer path verifies the handle " +
          "constant-time against the stored ticket; staff path uses the " +
          "`x-staff-token` header. Same-slot submissions return 200 with the " +
          "unchanged ticket (no-op success).",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    title: "CustomerReschedule",
                    type: "object",
                    required: ["nameKana", "phoneLast4", "newAppointmentAt"],
                    properties: {
                      nameKana: { type: "string" },
                      phoneLast4: { type: "string" },
                      newAppointmentAt: { type: "string", format: "date-time" },
                    },
                  },
                  {
                    title: "StaffReschedule",
                    type: "object",
                    required: ["newAppointmentAt"],
                    properties: {
                      newAppointmentAt: { type: "string", format: "date-time" },
                    },
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
                  required: ["ok", "waitingCount", "callableNowCount"],
                  properties: {
                    ok: { const: true },
                    waitingCount: { type: "integer", minimum: 0 },
                    callableNowCount: { type: "integer", minimum: 0 },
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
    "/queue/feed": {
      get: {
        tags: ["projection"],
        summary: "DO Hibernating WebSocket projection feed — server-push on every dispatch.",
        description:
          "Upgrade with `Connection: Upgrade` + `Upgrade: websocket`. " +
          "The DO emits the anonymous projection (waitingCount, serving, " +
          "waitingPreview) on every successful queue mutation. The current " +
          "snapshot is sent immediately on connect.",
        responses: {
          "101": {
            description: "Switching Protocols (WebSocket established)",
          },
          "426": {
            description: "Upgrade Required (no Upgrade: websocket header)",
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/staff/login": {
      post: {
        tags: ["staff"],
        summary: "Exchange the staff secret for a JWT + cookie session",
        description:
          "Accepts `{ password }`. On success returns `{ ok: true, " +
          "token, expiresIn }` and sets the `__Host-staff_session` " +
          "cookie. The Bearer token + the cookie are both honoured " +
          "by requireStaff; clients pick whichever fits their " +
          "transport.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["password"],
                properties: { password: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Login succeeded",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "token", "expiresIn"],
                  properties: {
                    ok: { const: true },
                    token: { type: "string" },
                    expiresIn: { type: "integer", minimum: 1 },
                  },
                },
              },
            },
          },
          "401": ERROR_RESPONSE,
          "422": ERROR_RESPONSE,
          "503": ERROR_RESPONSE,
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
