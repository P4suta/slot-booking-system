import { type ExecutionResult, GraphQLError, parse } from "graphql"
import { describe, expect, it } from "vitest"
import { buildOperationLogRecord } from "../../src/server/graphql/plugins/operationLogPlugin.js"

/**
 * `buildOperationLogRecord` — pin the wire-side contract for the
 * GraphQL operation access log: one record per operation, the right
 * fields, and the prod-mode variable redaction (ADR-0009).
 *
 * The plugin's `onExecute` / `onExecuteDone` arms are thin glue over
 * this pure derivation. Exercising the derivation under any
 * fixture is enough to pin the wire shape; the glue is exercised by
 * the Miniflare integration suite (commit 11) end-to-end.
 */

const okResult: ExecutionResult = { data: { okOp: { __typename: "MutationOkOpSuccess" } } }

const transportErrorResult: ExecutionResult = {
  errors: [
    new GraphQLError("TransportError (E_INF_TRANSPORT)", {
      extensions: {
        __typename: "TransportError",
        code: "E_INF_TRANSPORT",
        severity: "infrastructure",
      },
    }),
  ],
  data: null,
}

const validationErrorResult: ExecutionResult = {
  errors: [
    new GraphQLError("InvalidPhoneLast4 (E_VAL_PHONE_LAST4)", {
      extensions: {
        __typename: "InvalidPhoneLast4",
        code: "E_VAL_PHONE_LAST4",
        severity: "validation",
      },
    }),
  ],
  data: null,
}

describe("buildOperationLogRecord", () => {
  it("emits the success-path shape for a successful mutation", () => {
    const record = buildOperationLogRecord({
      document: parse("mutation Smoke { okOp { __typename } }"),
      variables: undefined,
      result: okResult,
      mode: "dev",
      latencyMs: 12,
    }) as { _tag: string; severity: string; data: Record<string, unknown> }
    expect(record._tag).toBe("GraphQLOperation")
    expect(record.severity).toBe("domain")
    expect(record.data.operationType).toBe("mutation")
    expect(record.data.operationName).toBe("Smoke")
    expect(record.data.status).toBe("ok")
    expect(record.data.latencyMs).toBe(12)
  })

  it("captures errorTag and infrastructure severity for TransportError", () => {
    const record = buildOperationLogRecord({
      document: parse("mutation { boomOp { __typename } }"),
      variables: undefined,
      result: transportErrorResult,
      mode: "dev",
      latencyMs: 8,
    }) as { severity: string; data: Record<string, unknown> }
    expect(record.severity).toBe("infrastructure")
    expect(record.data.status).toBe("transportError")
    expect(record.data.errorTag).toBe("TransportError")
  })

  it("classifies validation errors as domainError", () => {
    const record = buildOperationLogRecord({
      document: parse("mutation { holdSlot { __typename } }"),
      variables: undefined,
      result: validationErrorResult,
      mode: "dev",
      latencyMs: 5,
    }) as { severity: string; data: Record<string, unknown> }
    expect(record.severity).toBe("domain")
    expect(record.data.status).toBe("domainError")
    expect(record.data.errorTag).toBe("InvalidPhoneLast4")
  })

  it("redacts variable values in prod mode (keys only)", () => {
    const record = buildOperationLogRecord({
      document: parse("mutation Smoke($pii: String) { okOp { __typename } }"),
      variables: { pii: "alice", phoneLast4: "1234" },
      result: okResult,
      mode: "prod",
      latencyMs: 1,
    }) as { data: { variables?: Record<string, unknown> } }
    expect(record.data.variables).toEqual({
      pii: "<redacted>",
      phoneLast4: "<redacted>",
    })
  })

  it("keeps full variable values in dev mode", () => {
    const record = buildOperationLogRecord({
      document: parse("mutation Smoke($pii: String) { okOp { __typename } }"),
      variables: { pii: "alice" },
      result: okResult,
      mode: "dev",
      latencyMs: 1,
    }) as { data: { variables?: Record<string, unknown> } }
    expect(record.data.variables).toEqual({ pii: "alice" })
  })

  it("omits variables when the operation has none", () => {
    const record = buildOperationLogRecord({
      document: parse("mutation { okOp { __typename } }"),
      variables: undefined,
      result: okResult,
      mode: "prod",
      latencyMs: 1,
    }) as { data: Record<string, unknown> }
    expect(record.data.variables).toBeUndefined()
  })
})
