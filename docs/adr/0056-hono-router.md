# ADR-0056: Hono as the queue REST router

- Status: Accepted
- Date: 2026-05-09
- Refines: ADR-0050 (queue pivot)

## Decision

The queue's REST surface (`/api/v1/*`) is mounted on **Hono** rather
than a hand-rolled regex-walking router or `effect/platform`'s
`HttpRouter`. The router lives at
`apps/default/src/server/http/router.ts` and the worker mounts it
via `queueApi.fetch(request, env)` from the top-level `fetch`.

## Context

The pre-pivot router was a 349-LOC procedural walker that pattern-
matched paths with `URL` + regex, set CORS headers manually, and
serialised the error envelope through a `tag.startsWith("Invalid")`
chain. Every new endpoint added another regex and another arm; every
new domain error tag added a `||` to the status mapper.

Three options were on the table:

1. Keep the hand-rolled router and split it into helpers.
2. `effect/platform`'s `HttpRouter` (typed, Effect-native, depends on
   the Effect runtime at the boundary).
3. **Hono** (Cloudflare Workers' officially recommended router; trie-
   compiled path dispatch; ~12 KB gzip; zero runtime dependencies).

## Trade-offs

|                            | Hand-rolled | effect/platform | **Hono** |
|----------------------------|:-----------:|:---------------:|:--------:|
| Bundle size (gzip)         | 0           | ~80 KB          | ~12 KB   |
| Path-param typing          | manual      | yes             | yes      |
| Cloudflare Workers default | implicit    | layered         | yes      |
| Mainstream community size  | n/a         | small           | large    |
| Effect interop             | n/a         | native          | adapter  |

Hono wins on the Cloudflare-vendor alignment + bundle budget while
costing nothing on the path-typing axis. The Effect runtime stays
inside the use-case layer (where it belongs); the router does not
need it for path dispatch — `effect/platform` would couple the
HTTP surface to the runtime in ways the use-case boundary already
keeps decoupled.

## Consequences

- The router file shrinks 349 → ~330 LOC despite gaining
  schema-driven body / query validation and an exhaustive error
  envelope.
- New endpoints land in three places: a `Schema.Struct` body type, a
  Hono `app.{get,post}` block, and (if a new error tag is involved)
  an arm in `errorEnvelope.ts`'s `Match.tagged`. The exhaustive
  match flips a future error class into a compile error until the
  HTTP status is assigned.
- The DO Hibernating WebSocket upgrade path (deferred) will land as
  a Hono handler that hijacks the response into the
  `WebSocketPair`; Hono already provides the request/response API
  surface this needs.
- Bundle budget tracking: the worker's gzipped size cap stays
  comfortable at +12 KB for Hono; size-limit gates the long-tail
  drift in subsequent commits.
