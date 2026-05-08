import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base"
import { describe, expect, it } from "vitest"
import { chooseExporter } from "../src/server/observability/otelConfig.js"

/**
 * Pin the OTel exporter triage matrix for the worker boot path —
 * three explicit modes plus the dev/prod default. The matrix must
 * never lose a row silently because the `Network connection lost`
 * noise the wrong default produces is the single biggest dev-loop
 * friction.
 */

describe("chooseExporter", () => {
  it("returns ConsoleSpanExporter when OTEL_EXPORTER_URL='console'", () => {
    const exporter = chooseExporter({ OTEL_EXPORTER_URL: "console" })
    expect(exporter).toBeInstanceOf(ConsoleSpanExporter)
  })

  it("returns a no-op exporter when OTEL_EXPORTER_URL='disabled'", () => {
    const exporter = chooseExporter({ OTEL_EXPORTER_URL: "disabled" })
    expect(exporter).toHaveProperty("export")
    expect(exporter).toHaveProperty("shutdown")
    // Functional check — exporting a noop drops the spans without error.
    let result: { code: number } | undefined
    ;(exporter as { export: (s: never[], cb: (r: { code: number }) => void) => void }).export(
      [],
      (r) => {
        result = r
      },
    )
    expect(result).toEqual({ code: 0 })
  })

  it("returns the OTLP URL config when OTEL_EXPORTER_URL is a concrete URL", () => {
    const exporter = chooseExporter({ OTEL_EXPORTER_URL: "https://otel.example.com/v1/traces" })
    expect(exporter).toEqual({
      url: "https://otel.example.com/v1/traces",
      headers: {},
    })
  })

  it("attaches Bearer auth when OTEL_EXPORTER_KEY is set", () => {
    const exporter = chooseExporter({
      OTEL_EXPORTER_URL: "https://otel.example.com/v1/traces",
      OTEL_EXPORTER_KEY: "secret",
    })
    expect(exporter).toEqual({
      url: "https://otel.example.com/v1/traces",
      headers: { authorization: "Bearer secret" },
    })
  })

  it("defaults to ConsoleSpanExporter when IS_DEV='1' and URL is missing", () => {
    const exporter = chooseExporter({ IS_DEV: "1" })
    expect(exporter).toBeInstanceOf(ConsoleSpanExporter)
  })

  it("defaults to no-op when IS_DEV is missing (= prod) and URL is missing", () => {
    const exporter = chooseExporter({})
    expect(exporter).toHaveProperty("export")
    expect(exporter).not.toBeInstanceOf(ConsoleSpanExporter)
  })

  it("defaults to no-op when IS_DEV='0' (= prod) and URL is missing", () => {
    const exporter = chooseExporter({ IS_DEV: "0" })
    expect(exporter).toHaveProperty("export")
    expect(exporter).not.toBeInstanceOf(ConsoleSpanExporter)
  })
})
