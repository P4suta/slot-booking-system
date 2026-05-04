# 0015. Development, test, and CI run inside the Docker dev container

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: infra, reproducibility

## Context

Reproducibility is hard when developers run the project against whatever Node, pnpm, wrangler, and OS happen to be on their machine. A package upgrade that "works on my machine" routinely breaks CI, and CI that diverges from local dev produces "but it passed locally" reports that nobody can explain.

## Decision

- Every command that touches Node, pnpm, wrangler, biome, vitest, tsc, or drizzle-kit runs **inside the dev container** (`docker compose run --rm dev …`).
- The `Justfile` recipes are the canonical entry points; they all expand to the `docker compose run --rm dev` form.
- The host installs only the bootstrap layer: `just`, `lefthook`, `committed`, `typos`, `actionlint`, `markdownlint-cli2` (managed by `mise`). No Node, no pnpm.
- CI invokes the **same** image via `docker compose build ci && docker compose run --rm ci …` so local and CI paths are byte-identical except for the readonly mount.
- Named volumes (`pnpm-store`, `pnpm-home`) cache the pnpm store between runs.

## Consequences

- "It works on my machine" reduces to "it works on my Docker daemon", which is the same daemon as CI.
- First-time bootstrap is slower (image build), but cached re-runs are sub-second to cold-start.
- Updating Node or pnpm is a one-line change in `Dockerfile`; no docs to sync.
- Engineers without local Node tooling are productive on day one.

## Consequences (negative)

- IDE integrations (LSP, debugger) need to attach to the container. The Justfile exposes `just sh` to drop into an interactive shell when needed.
- Compose port publishing is required for `wrangler dev` and the SvelteKit dev server.

## Alternatives considered

- **Devcontainer / VS Code only**: works for VS Code users; locks others out.
- **mise-managed Node + pnpm on host**: not bit-exact across hosts; environment drift over months.
- **Nix shell**: high learning cost; team is not Nix-fluent.

## References

- Memory `feedback_docker_only_execution.md`, `feedback_docker_everywhere.md`.
- SYSTEM.md §4.3 ("Wrangler", "Biome", … all listed but no environment policy).
