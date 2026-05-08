import { trace } from "@opentelemetry/api"
import { type DocumentNode, type ExecutionResult, Kind, OperationTypeNode } from "graphql"
import type { Plugin } from "graphql-yoga"
import type { GraphQLContext } from "../context.js"

const FIELD_OPERATION_TYPE = "operationType"

type OperationContext = {
  readonly operationName: string | undefined
  readonly operationType: "query" | "mutation" | "subscription"
  readonly redactedVariables: Record<string, unknown> | undefined
  readonly startedAt: number
}

const operationStateBySymbol = new WeakMap<object, OperationContext>()

const operationTypeOf = (document: DocumentNode): "query" | "mutation" | "subscription" => {
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) {
      if (def.operation === OperationTypeNode.MUTATION) return "mutation"
      if (def.operation === OperationTypeNode.SUBSCRIPTION) return "subscription"
      return "query"
    }
  }
  return "query"
}

const operationNameOf = (document: DocumentNode): string | undefined => {
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) return def.name?.value
  }
  return undefined
}

const traceIdHex = (): string | undefined => {
  const span = trace.getActiveSpan()
  if (span === undefined) return undefined
  const ctx = span.spanContext()
  return ctx.traceId === "" ? undefined : ctx.traceId
}

const redactVariables = (
  vars: Readonly<Record<string, unknown>> | null | undefined,
  mode: "dev" | "prod",
): Record<string, unknown> | undefined => {
  if (vars === null || vars === undefined) return undefined
  if (mode === "dev") return { ...vars }
  // prod: keys only — `nameKana` / `phoneLast4` / `freeText` MUST NOT
  // surface to log sinks (ADR-0009). The keys themselves are part of
  // the schema, so leaking them is fine.
  return Object.fromEntries(Object.keys(vars).map((k) => [k, "<redacted>"]))
}

type FirstError = {
  readonly tag: string | undefined
  readonly status: "domainError" | "transportError" | "unknownError"
}

const firstErrorOf = (result: ExecutionResult): FirstError | undefined => {
  if (!result.errors || result.errors.length === 0) return undefined
  const err = result.errors[0]
  if (err === undefined) return undefined
  const ext = err.extensions as { __typename?: unknown; severity?: unknown } | undefined
  const tag = typeof ext?.__typename === "string" ? ext.__typename : undefined
  const severity = typeof ext?.severity === "string" ? ext.severity : undefined
  if (tag === "TransportError") return { tag, status: "transportError" }
  if (severity === "validation" || severity === "domain") {
    return { tag, status: "domainError" }
  }
  return { tag, status: "unknownError" }
}

const statusToSeverity = (
  status: "domainError" | "transportError" | "unknownError",
): "validation" | "domain" | "infrastructure" => {
  switch (status) {
    case "transportError":
    case "unknownError":
      return "infrastructure"
    default:
      return "domain"
  }
}

/**
 * Pure derivation extracted so it can be exercised under any
 * fixture without spinning up a yoga / envelop runtime. Produces
 * the same `LogPayload`-shaped record the plugin's `onExecuteDone`
 * arm emits.
 */
export const buildOperationLogRecord = (input: {
  readonly document: DocumentNode
  readonly variables: Readonly<Record<string, unknown>> | null | undefined
  readonly result: ExecutionResult
  readonly mode: "dev" | "prod"
  readonly latencyMs: number
}): Record<string, unknown> => {
  const failure = firstErrorOf(input.result)
  const status = failure?.status ?? "ok"
  const severity = failure === undefined ? "domain" : statusToSeverity(failure.status)
  const operationName = operationNameOf(input.document)
  const operationType = operationTypeOf(input.document)
  const variables = redactVariables(input.variables, input.mode)
  const traceId = traceIdHex()
  return {
    _tag: "GraphQLOperation",
    code: "I_GRAPHQL_OP",
    severity,
    data: {
      ...(operationName !== undefined ? { operationName } : {}),
      [FIELD_OPERATION_TYPE]: operationType,
      latencyMs: input.latencyMs,
      status,
      ...(failure?.tag !== undefined ? { errorTag: failure.tag } : {}),
      ...(variables !== undefined ? { variables } : {}),
    },
    ...(traceId !== undefined ? { traceId } : {}),
  }
}

/**
 * Yoga plugin that emits one structured JSON record per GraphQL
 * operation. Reads `runtimeMode` and `emitOperationLog` from the
 * per-request {@link GraphQLContext} so the plugin itself stays
 * stateless (cheap to register at module load).
 *
 * Fields:
 *
 *   - `_tag` `"GraphQLOperation"`
 *   - `code` `"I_GRAPHQL_OP"`
 *   - `severity` `"validation" | "domain" | "infrastructure"`
 *   - `data.operationName?`, `data.operationType`,
 *     `data.latencyMs`, `data.status`, `data.errorTag?`,
 *     `data.variables?` (dev: full / prod: keys only)
 *   - `traceId` lifted from the active OTel span when present
 */
/**
 * Internal narrowing for the `args` graphql-yoga / envelop hands to
 * the plugin hooks. `Plugin<GraphQLContext>` widens contextValue back
 * to `Record<string, any>` somewhere along the chain (envelop's
 * `Record<string, any> & PluginContext` constraint), so the explicit
 * shape lets the consuming code stay strict without scattered
 * `as`-cast noise.
 */
type StrictArgs = {
  readonly document: DocumentNode
  readonly variableValues: Readonly<Record<string, unknown>> | null | undefined
  readonly contextValue: GraphQLContext
}

const narrowArgs = (rawArgs: unknown): StrictArgs => rawArgs as StrictArgs

export const operationLogPlugin = (): Plugin<GraphQLContext> => ({
  onExecute(payload) {
    const args = narrowArgs(payload.args)
    const startedAt = performance.now()
    const opCtx: OperationContext = {
      operationName: operationNameOf(args.document),
      operationType: operationTypeOf(args.document),
      redactedVariables: redactVariables(args.variableValues, args.contextValue.runtimeMode),
      startedAt,
    }
    operationStateBySymbol.set(args, opCtx)

    return {
      onExecuteDone({ result }) {
        if (Symbol.asyncIterator in result) return // streaming responses — out of scope
        const single = result as ExecutionResult
        const state = operationStateBySymbol.get(args)
        if (state === undefined) return
        operationStateBySymbol.delete(args)

        const record = buildOperationLogRecord({
          document: args.document,
          variables: args.variableValues,
          result: single,
          mode: args.contextValue.runtimeMode,
          latencyMs: Math.round(performance.now() - state.startedAt),
        })
        args.contextValue.emitOperationLog(record)
      },
    }
  },
})
