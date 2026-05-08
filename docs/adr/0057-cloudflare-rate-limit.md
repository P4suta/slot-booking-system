# ADR-0057: Cloudflare rate-limit binding for queue mutations

- Status: Accepted
- Date: 2026-05-09
- Refines: ADR-0050 (queue pivot)

## Decision

Customer issue + staff mutation endpoints sit behind Cloudflare's
native rate-limit binding (`[[unsafe.bindings]] type = "ratelimit"`)
rather than an in-memory token bucket or D1-backed counter. Two
namespaces ship by default and live in `apps/default/wrangler.toml`:

|        Binding | Limit / period |              Key                |
| -------------- | -------------- | ------------------------------- |
|       RL_ISSUE | 60 / 60 s      | `cf-connecting-ip`              |
|     RL_OPERATE | 300 / 60 s     | `x-staff-token` (staff secret)  |

Hono middleware (`apps/default/src/server/http/rateLimit.ts`)
extracts the configured key, calls `binding.limit({ key })`, and
rejects with `429 Retry-After: 60` on the failure path. Miniflare
does not implement `[[unsafe.bindings]]`, so the dev path's
binding is `undefined` and the middleware fails open — production
runs against the real binding and rejects correctly.

## Context

The rate-limit problem on a queue endpoint splits into two regimes:

1. The customer-side issue path is the only place a single client
   can starve the queue with a script. One ticket every two
   seconds is generous for a human walk-up; 60 / minute matches.
2. The staff-side mutation path is keyed on the operator's
   capability token, so a bursty operator dashboard tab + a
   colleague on the same shift share a budget. 300 / minute
   covers a busy hour without ever clipping a real human.

In-memory token buckets share no state across DO replicas + worker
isolates and break under Cloudflare's globally-distributed runtime.
A D1-backed counter requires a write per request and adds
multi-millisecond latency. The native binding has none of those
costs and is the platform-recommended path for Workers (Cloudflare
docs, "Rate Limiting (beta)").

## Consequences

- Local-dev triage with `wrangler dev --local` does not see the
  rate-limit (Miniflare unbinding); CI's wrangler `--env=production
  build` job asserts the binding is present in the toml.
- A DDoS via rotated IPs slips RL_ISSUE; the queue's ultimate
  defence remains Cloudflare's edge mitigation + Workers'
  per-script CPU cap. The binding is a back-pressure tool, not a
  perimeter.
- Adding a new rate-limited route is a one-line change:
  `app.post("/path", rateLimitMiddleware("RL_OPERATE"), ...)`.

Superseded-By:
