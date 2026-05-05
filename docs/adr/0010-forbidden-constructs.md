# 0010. Forbidden TypeScript constructs and where they are forbidden

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: correctness, conventions

## Context

A handful of language constructs silently weaken the type system or smuggle side effects into pure code. We enumerate them once and let CI enforce the rule rather than relying on review.

## Decision

The following are **forbidden** in `packages/core/src/**` and `apps/*/src/**` (server code), enforced by CI ripgrep:

| Construct                 | Why forbidden                                  |
| ------------------------- | ---------------------------------------------- |
| `any`                     | Erases information, infects callers.           |
| `as <Type>` (cast)        | Bypasses smart constructors.                    |
| `@ts-ignore`              | Suppresses errors instead of fixing them.       |
| `@ts-expect-error`        | Same — only allowed in `test/type/` for type-level negative tests. |
| `unknown` outside boundaries | Boundary code (HTTP, DB) decodes via Effect Schema; no `unknown` past the door. |
| `throw …`                 | Errors must travel as values (Effect or `Result`). |
| `Promise<T>` returns in `application/usecases/**` | Use cases must return `Effect.Effect<…>`. SvelteKit / Worker handlers convert at the boundary. |
| `new Date(…)` / `Date.now()` | Forbidden globally — see ADR-0004.            |

Permitted boundaries:

- `Effect.runPromise` lives **only** in presentation entry points (one file per app).
- `Schema.decode` accepts `unknown` and produces a domain type. Decoding is the only legal place `unknown` appears.
- Type-level negative tests in `test/type/*.test-d.ts` may use `@ts-expect-error`.

## Consequences

- Reviewer load drops: CI catches the common errors mechanically.
- Adding a new forbidden construct is a one-line ADR addendum and a one-line guard rule.

## Alternatives considered

- **ESLint custom rules**: heavier than ripgrep, additional lint runtime, and Biome (our chosen lint stack) does not support custom AST rules in 2.4.
- **Code review only**: decays as the team / codebase grows.

## References

- SYSTEM.md §2.6, §4.5.5, §7.11.
- ADR-0004 (Date forbidden).
