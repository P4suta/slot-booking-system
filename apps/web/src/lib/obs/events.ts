/**
 * Client-side observability event model (Stage 20 / ADR-0088).
 *
 * The discriminated union over `kind` is the wire shape every other
 * obs module (`ringBuffer`, `bus`, `reporter`) consumes. Each
 * variant carries every field the post-mortem needs *at the call
 * site*, so the ring snapshot is replayable without joining
 * against another source. Numeric timestamps (`at`) are Unix-millis
 * epoch so a serialised ring still sorts after `JSON.parse` without
 * an intermediate `Date` round-trip.
 *
 * Severity is layered as a non-intrinsic attribute (`DevEvent
 * WithSeverity = DevEvent & { severity }`) rather than baked into
 * each variant. The bus picks a sensible default by `kind` (see
 * `bus.ts#defaultSeverityFor`), and the caller can override per
 * emit so a context-dependent classification (e.g. `WsClose` with
 * code 4429 = rate-limit → error, code 1001 = page-unload → info)
 * stays at the emit site rather than buried in the type.
 *
 * INVARIANT: every variant must include `at: number`. Downstream
 * sort + replay code depends on a non-optional timestamp; ad-hoc
 * "the bus stamps it" was rejected because the local emit site
 * always has the most accurate timing for fetch durations etc.
 */

export type Severity = "debug" | "info" | "warning" | "error"

export type DevEvent =
  | {
      readonly kind: "FetchStart"
      readonly traceId: string
      readonly method: string
      readonly path: string
      readonly at: number
    }
  | {
      readonly kind: "FetchEnd"
      readonly traceId: string
      readonly method: string
      readonly path: string
      readonly status: number
      readonly ms: number
      readonly ok: boolean
      readonly at: number
    }
  | {
      readonly kind: "FetchError"
      readonly traceId: string
      readonly method: string
      readonly path: string
      readonly reason: string
      readonly at: number
    }
  | { readonly kind: "WsOpen"; readonly at: number }
  | {
      readonly kind: "WsFrameIn"
      readonly capability: "anonymous" | "staff"
      readonly frameKind: "snapshot" | "delta"
      readonly bytes: number
      readonly triggerTraceId: string | null
      readonly at: number
    }
  | {
      readonly kind: "WsClose"
      readonly code: number
      readonly reason: string
      readonly wasClean: boolean
      readonly at: number
    }
  | { readonly kind: "WsError"; readonly reason: string; readonly at: number }
  | {
      readonly kind: "StoreMutation"
      readonly store: string
      readonly summary: string
      readonly at: number
    }
  | {
      readonly kind: "UncaughtError"
      readonly message: string
      readonly stack: string | null
      readonly at: number
    }
  | {
      readonly kind: "Lifecycle"
      readonly phase: "mount" | "unmount" | "navigate"
      readonly route: string
      readonly at: number
    }

export type DevEventWithSeverity = DevEvent & { readonly severity: Severity }
