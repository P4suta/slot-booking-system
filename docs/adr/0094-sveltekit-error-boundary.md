# ADR-0094: SvelteKit error boundary — `handleError` + `+error.svelte`

- Status: Accepted
- Date: 2026-05-12
- Stage: F / S24
- Refines: ADR-0088 (client obs ring), ADR-0090 (client
  error endpoint)

## Decision

Wire SvelteKit's `handleError` hook on both sides (client +
server) so every uncaught throw past a route boundary
funnels through a single emit point that:

1. Mints a fresh trace id (the SvelteKit adapter on
   Cloudflare runs outside the `@microlabs/otel-cf-workers`
   instrumentation chain, so `currentTraceId()` is
   unreachable from here).
2. Emits an `UncaughtError` through `obsBus` (client) or
   `console.error` a structured-log line (server). The
   client emit feeds the existing reporter → S22a endpoint
   → S22 cont. dev relay chain unchanged.
3. Returns an `App.Error` shape `{ message, traceId }` so
   `+error.svelte` can render the trace id as a copyable
   code block — the customer can quote it back to support.

```ts
// apps/web/src/hooks.client.ts
export const handleError: HandleClientError = ({ error, event, status, message }) => {
  const traceId = generateTraceId()
  const detail = error instanceof Error ? error.message : String(error)
  obsBus.emit({
    kind: "UncaughtError",
    message: `${event.url.pathname}: ${detail}`,
    stack: error instanceof Error ? (error.stack ?? null) : null,
    at: Date.now(),
  })
  return {
    message: status >= 500 ? "予期しないエラーが発生しました。" : message,
    traceId,
  }
}
```

### Why each boundary mints its own trace id

The hook runs inside the SvelteKit adapter's runtime
(Cloudflare Workers in prod, Vite in dev) — *not* inside
the `instrument(handler, otelConfig)` wrap. The OTel
context propagation that lets `currentTraceId()` work
inside the API surface stops at the adapter boundary, so
there is no upstream trace id to carry forward.

A fresh id per hook is acceptable because the customer's
session id (`obs.sessionId.v1`) + the timestamp are
enough for the operator dashboard to correlate the
`+error.svelte` render with whatever upstream API call
preceded it. The id on the render is purely a "what to
quote" surface, not a tracing primary key.

### Server-side message sanitisation

```ts
return {
  message: status >= 500 ? "予期しないエラーが発生しました。" : message,
  traceId,
}
```

For 5xx the message is replaced with a neutral string —
production never leaks raw exception text past 500. For
4xx the SvelteKit-provided message (e.g. "Not Found") is
fine to surface; those errors are user-action driven.

### `+error.svelte` UX

The boundary renders a single centred card matching the
customer-facing modal styling:

- Status line ("エラー 500") for context.
- Sanitised heading message.
- Trace id as a copyable `<code>` with `user-select: all`.
- One link back to `/` (no second action — the customer's
  only useful next step is "retry from the top").

The page intentionally has no keyboard shortcuts — same
discipline as the rest of the customer-facing UI.

## Consequences

- Every uncaught throw inside a `+page.svelte` lifecycle,
  `+layout.svelte` lifecycle, or load function now surfaces
  in `/dev/inspect`'s Ring (client) or Stream (server)
  pane through the existing obs chain — no new wiring at
  individual emit sites.
- The customer sees a trace id they can quote back to
  support, joining the production audit-log row that the
  reporter already deposited.
- `App.Error` interface in `app.d.ts` widens with
  `traceId?: string`; the `Locals` / `Platform` /
  `PageData` namespaces are unchanged.

## Status

- 2026-05-12 — `hooks.client.ts` + `hooks.server.ts`
  +error.svelte land in commit `a8d3c8c`.
