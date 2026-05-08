import { context, trace } from "@opentelemetry/api"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * Phase 2.6 / BI-9 + ADR-0038 carry-over — e2e span emission via
 * `BasicTracerProvider` + `InMemorySpanExporter`.
 *
 * The contract being asserted: every domain-error code path emits an
 * OTel span carrying semantic-convention `error.*` attributes
 * (`error.type`, `error.code`, `error.severity`) plus a
 * `recordException` event. The exporter captures finished spans for
 * inspection without a real OTLP endpoint.
 *
 * The full GraphQL pipeline (Yoga → Pothos → DO RPC) is exercised
 * elsewhere in integration; here we assert the OTel plumbing alone:
 * a span created with `error.*` attributes survives the exporter
 * round-trip with the attributes intact.
 *
 * OTel SDK 2.x configures span processors via the `TracerConfig`
 * constructor option (`addSpanProcessor` was removed).
 */
describe("InMemorySpanExporter — span emission contract (ADR-0038)", () => {
  let provider: BasicTracerProvider
  let exporter: InMemorySpanExporter

  beforeEach(() => {
    exporter = new InMemorySpanExporter()
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    trace.setGlobalTracerProvider(provider)
  })

  afterEach(async () => {
    await provider.shutdown()
    exporter.reset()
  })

  it("captures error.* semconv attributes on a failed span", () => {
    const tracer = provider.getTracer("test")
    const span = tracer.startSpan("graphql.holdSlot")
    span.setAttribute("error.type", "InvalidPhoneLast4")
    span.setAttribute("error.code", "E_VAL_PHONE_LAST4")
    span.setAttribute("error.severity", "validation")
    span.recordException({ name: "InvalidPhoneLast4", message: "E_VAL_PHONE_LAST4" })
    span.end()

    const finished = exporter.getFinishedSpans()
    expect(finished).toHaveLength(1)
    expect(finished[0]?.name).toBe("graphql.holdSlot")
    expect(finished[0]?.attributes["error.type"]).toBe("InvalidPhoneLast4")
    expect(finished[0]?.attributes["error.code"]).toBe("E_VAL_PHONE_LAST4")
    expect(finished[0]?.attributes["error.severity"]).toBe("validation")
    expect(finished[0]?.events.some((e) => e.name === "exception")).toBe(true)
  })

  it("captures the parent → child span tree shape (root + audit_write)", async () => {
    const tracer = provider.getTracer("test")
    const root = tracer.startSpan("graphql.confirm")
    const ctx = trace.setSpan(context.active(), root)
    const audit = tracer.startSpan("audit_write", undefined, ctx)
    audit.end()
    root.end()
    await provider.forceFlush()

    const finished = exporter.getFinishedSpans()
    expect(finished.map((s) => s.name).sort()).toEqual(["audit_write", "graphql.confirm"])
  })
})
