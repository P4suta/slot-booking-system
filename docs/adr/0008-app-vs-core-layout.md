# 0008. SvelteKit apps live in `apps/*`; `packages/core` is a pure TS library

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: architecture, layout

## Context

SYSTEM.md §4.5.2 sketched `packages/core/src/presentation/routes/` for SvelteKit. That makes "core" simultaneously a library and an app, which makes deployment, packaging, and testing all subtly harder.

## Decision

- `packages/core/` exports **only** `domain` + `application` + `infrastructure-port` types. It is a pure TypeScript library: no SvelteKit, no Svelte components, no Cloudflare bindings.
- `apps/*/` (e.g., `apps/default/`) contain the SvelteKit + Cloudflare Worker + Drizzle adapters. They depend on `@booking/core` via `workspace:*` (and, in the future bikeshop repo, via a published tarball — see ADR-0011).
- Cross-cutting concerns that need a Cloudflare binding (e.g., `BookingRepository` wired to D1) live in `apps/*/src/server/adapters/`. The port type comes from `@booking/core/application`.

## Consequences

- `packages/core` ships in a runtime-agnostic package: import it from a Worker, from a Node script, from a one-off test, from a future bikeshop repo. None of those paths drag in SvelteKit.
- The presentation layer can change wholesale (e.g., swap SvelteKit for Astro) without touching the core.
- dependency-cruiser can enforce: `packages/core/**` cannot import `cloudflare:*`, `@sveltejs/*`, or anything below `apps/*`.

## Alternatives considered

- **Keep SvelteKit inside core** (SYSTEM.md original sketch): mixes library and app concerns.
- **Single flat repo, no packages**: works, but the future bikeshop repo would have to copy-paste the core or vendor it.

## References

- SYSTEM.md §4.5.1, §4.5.2.
- ADR-0011 (distribution shape).
