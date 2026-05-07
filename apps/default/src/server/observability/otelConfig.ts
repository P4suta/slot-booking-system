import {
  ConsoleSpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base"

/**
 * Structural alias for `@opentelemetry/core`'s `ExportResult` so the
 * deployment does not need a direct dependency on `core` (it is a
 * transitive of `sdk-trace-base`). The shape is fixed in OTel's
 * stable API; `code: 0` denotes success.
 */
type ExportResult = { readonly code: number; readonly error?: Error }

/**
 * Pure-noop exporter — drops spans, never errors. Used in production
 * deploys without an OTLP collector and as the safe default for
 * `wrangler dev` runs that have not opted into the observability
 * stack (`just dev-up`). ADR-0042 / ADR-0044.
 */
class NoopSpanExporter implements SpanExporter {
  export(_spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    resultCallback({ code: 0 })
  }
  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

export type ExporterEnv = {
  readonly IS_DEV?: string
  readonly OTEL_EXPORTER_URL?: string
  readonly OTEL_EXPORTER_KEY?: string
}

/**
 * Choose the OTel exporter based on the worker `env`. Three explicit
 * modes plus a defensible default per RuntimeMode:
 *
 *   - `OTEL_EXPORTER_URL === "console"`  → `ConsoleSpanExporter`
 *   - `OTEL_EXPORTER_URL === "disabled"` → `NoopSpanExporter`
 *   - any URL                             → `OTLPExporterConfig`
 *   - empty / missing                     → dev:console / prod:noop
 *
 * The disabled and console arms drop the network round-trip, which
 * is the practical fix for the dev-loop pain that prompted this
 * commit: `wrangler dev` no longer spams `OTLPExporterError: Network
 * connection lost` when no collector is listening.
 */
export const chooseExporter = (
  env: ExporterEnv,
): SpanExporter | { url: string; headers: Record<string, string> } => {
  const url = env.OTEL_EXPORTER_URL
  if (url === "console") return new ConsoleSpanExporter()
  if (url === "disabled") return new NoopSpanExporter()
  if (url === undefined || url === "") {
    return env.IS_DEV === "1" ? new ConsoleSpanExporter() : new NoopSpanExporter()
  }
  return {
    url,
    headers:
      env.OTEL_EXPORTER_KEY !== undefined
        ? { authorization: `Bearer ${env.OTEL_EXPORTER_KEY}` }
        : {},
  }
}
