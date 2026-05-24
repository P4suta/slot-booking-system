/**
 * OpenAPI 3.1 document for the queue REST surface.
 *
 * Request-body and query schemas are derived from the
 * `boundarySchemas.ts` declarations through
 * `openapiRegistry.ts#bodySchemaFor` (ADR-0078). Response-side
 * Ticket / ProjectionEntry / envelope shapes are derived from
 * `responseSchemas.ts` through `openapiRegistry.ts#responseSchemaFor`
 * (ADR-0085) — adding a new response shape is one entry in
 * `responseRegistry` plus the path stanza here. The narrative
 * pieces (paths, summaries, tag groupings, auth-side request
 * bodies that have no Effect.Schema counterpart) remain hand-
 * written.
 *
 * The shared `components.schemas` slot carries every `$defs`
 * entry the derived schemas pull in (e.g. `Instant`), keyed under
 * the sanitised OpenAPI component names produced by
 * `JsonSchema.toMultiDocumentOpenApi3_1`, plus the response-side
 * shapes (Ticket, ProjectionEntry, …) lifted as named components
 * so paths can `$ref` them.
 */
import { bodySchemaFor, buildOpenApiBundle, responseSchemaFor } from "./openapiRegistry.js"

const openApiBundle = buildOpenApiBundle()
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

// The `Ticket`, `ProjectionEntry`, `TicketEnvelope`, and
// `IssueTicketMergedEnvelope` shapes live in `components.schemas`
// (below) and are derived from `responseSchemas.ts` (ADR-0085).
// Endpoints `$ref` the lifted name so the per-path `responses`
// stay declarative and stay in sync when the wire schema changes.
const TICKET_REF = { $ref: "#/components/schemas/Ticket" } as const
const PROJECTION_ENTRY_REF = { $ref: "#/components/schemas/ProjectionEntry" } as const

const TICKET_ENVELOPE = {
  description: "Ticket envelope",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/TicketEnvelope" },
    },
  },
} as const

// ADR-0069 §idempotent merge — the `IssueTicket` handler returns
// `200 OK` with `merged: true` on a duplicate-handle issue. The
// envelope carries the same `ticket` shape as the 201 fresh case.
const ISSUE_TICKET_MERGED_ENVELOPE = {
  description: "Idempotent merge envelope (ADR-0069); existing ticket returned with `merged: true`",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/IssueTicketMergedEnvelope" },
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
            "application/json": { schema: bodySchemaFor("IssueTicketBody") },
          },
        },
        responses: {
          "201": TICKET_ENVELOPE,
          "200": ISSUE_TICKET_MERGED_ENVELOPE,
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
          // SlotsQuery: { from: Date, to: Date, granularity: 15|30|60 }
          {
            in: "query",
            name: "query",
            required: true,
            content: { "application/json": { schema: bodySchemaFor("SlotsQuery") } },
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
          // ByHandleQuery: { nameKana, phoneLast4 }
          {
            in: "query",
            name: "query",
            required: true,
            content: { "application/json": { schema: bodySchemaFor("ByHandleQuery") } },
          },
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
                oneOf: [bodySchemaFor("CancelBody"), bodySchemaFor("StaffCancelBody")],
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
    "/tickets/{id}/push-subscription": {
      post: {
        tags: ["customer"],
        summary: "Register a Web Push subscription for the ticket",
        description:
          "ADR-0073 / ADR-0074. The customer registers a browser-side " +
          "PushSubscription so the alarm sweep can deliver Overdue nudges " +
          "to a closed tab. Customer-authenticated via `(nameKana, " +
          "phoneLast4)` (cancel-pattern parity). The endpoint host is " +
          "gated to the known push services (FCM / Mozilla / Apple).",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: bodySchemaFor("PushSubscriptionBody") },
          },
        },
        responses: {
          "201": {
            description: "Subscription registered",
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
          "403": ERROR_RESPONSE,
          "404": ERROR_RESPONSE,
          "409": ERROR_RESPONSE,
          "422": ERROR_RESPONSE,
        },
      },
      delete: {
        tags: ["customer"],
        summary: "Unregister a Web Push subscription",
        description:
          "ADR-0073 / ADR-0074. Customer-initiated unsubscribe (e.g. on " +
          "permission revoke or device cleanup). Idempotent; missing row " +
          "still returns 200. Authenticated via query string (DELETE " +
          "bodies are non-portable across user-agents).",
        parameters: [
          { in: "path", name: "id", required: true, schema: { type: "string" } },
          // PushSubscriptionDeleteQuery: { nameKana, phoneLast4, endpoint }
          {
            in: "query",
            name: "query",
            required: true,
            content: {
              "application/json": { schema: bodySchemaFor("PushSubscriptionDeleteQuery") },
            },
          },
        ],
        responses: {
          "200": {
            description: "Subscription unregistered (idempotent)",
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
          "403": ERROR_RESPONSE,
          "404": ERROR_RESPONSE,
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
          // RescheduleBody covers both customer (handle required) and
          // staff (handle absent) paths via optional `nameKana` /
          // `phoneLast4`. The router branches by handle presence.
          content: {
            "application/json": { schema: bodySchemaFor("RescheduleBody") },
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
        summary: "Staff: mark Called or Overdue → Served",
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
        summary: "Staff: mark Called or Overdue → NoShow",
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
        summary: "Staff: recall (Called or Overdue → Waiting, original seq preserved)",
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
        summary: "Anonymous shop projection — PII-free, seq/lane/displaySeq only (ADR-0084)",
        description:
          "ADR-0084 split — this endpoint returns the anonymous projection " +
          "regardless of any auth header. Staff dashboards call " +
          "`/queue/staff` for the full-ticket payload.",
        responses: {
          "200": {
            description: "Anonymous projection envelope",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: [
                    "ok",
                    "v",
                    "waitingCount",
                    "laneCounts",
                    "calling",
                    "overdue",
                    "waitingPreview",
                    "nextReservationDeadline",
                  ],
                  properties: {
                    ok: { const: true },
                    v: { const: 4 },
                    waitingCount: { type: "integer", minimum: 0 },
                    laneCounts: {
                      type: "object",
                      required: ["walkIn", "reservation"],
                      properties: {
                        walkIn: { type: "integer", minimum: 0 },
                        reservation: { type: "integer", minimum: 0 },
                      },
                    },
                    calling: { type: "array", items: PROJECTION_ENTRY_REF },
                    overdue: { type: "array", items: PROJECTION_ENTRY_REF },
                    waitingPreview: { type: "array", items: PROJECTION_ENTRY_REF },
                    nextReservationDeadline: {
                      type: ["string", "null"],
                      format: "date-time",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/queue/staff": {
      get: {
        tags: ["staff", "projection"],
        summary: "Staff shop projection — full Ticket rows + `terminal` history (ADR-0084)",
        description:
          "ADR-0084 split — staff dashboards call this endpoint instead " +
          "of `/queue` so the response shape is statically known. " +
          "Requires `x-staff-token`, `Authorization: Bearer <jwt>`, or " +
          "the `__Host-staff_session` cookie.",
        responses: {
          "200": {
            description: "Staff projection envelope (PII inclusive)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: [
                    "ok",
                    "v",
                    "waitingCount",
                    "laneCounts",
                    "calling",
                    "overdue",
                    "waitingPreview",
                    "terminal",
                    "nextReservationDeadline",
                  ],
                  properties: {
                    ok: { const: true },
                    v: { const: 4 },
                    waitingCount: { type: "integer", minimum: 0 },
                    laneCounts: {
                      type: "object",
                      required: ["walkIn", "reservation"],
                      properties: {
                        walkIn: { type: "integer", minimum: 0 },
                        reservation: { type: "integer", minimum: 0 },
                      },
                    },
                    calling: { type: "array", items: TICKET_REF },
                    overdue: { type: "array", items: TICKET_REF },
                    waitingPreview: { type: "array", items: TICKET_REF },
                    terminal: { type: "array", items: TICKET_REF },
                    nextReservationDeadline: {
                      type: ["string", "null"],
                      format: "date-time",
                    },
                  },
                },
              },
            },
          },
          "401": ERROR_RESPONSE,
          "503": ERROR_RESPONSE,
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
          "The DO emits the anonymous projection (waitingCount, calling, " +
          "overdue, waitingPreview) on every successful queue mutation. The " +
          "current snapshot is sent immediately on connect.",
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
  components: {
    schemas: {
      ...openApiBundle.components,
      // Response-side shapes lifted to component refs (ADR-0085).
      // Derived from `responseSchemas.ts` through the same
      // Effect-Schema → OpenAPI 3.1 pipeline that powers the
      // boundary registry. Adding a new shared response shape is
      // a 1-line edit in `responseRegistry`.
      Ticket: responseSchemaFor("Ticket"),
      ProjectionEntry: responseSchemaFor("ProjectionEntry"),
      TicketEnvelope: responseSchemaFor("TicketEnvelope"),
      IssueTicketMergedEnvelope: responseSchemaFor("IssueTicketMergedEnvelope"),
    },
  },
} as const
