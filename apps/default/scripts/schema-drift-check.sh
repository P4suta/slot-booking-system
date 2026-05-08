#!/usr/bin/env bash
# Phase 3 PR#8 — drift gate for `apps/default/schema.graphql`.
#
# Re-renders the SDL via `pnpm print-schema` (the same command the
# generated `apps/web/src/graphql-env.d.ts` typegen consumes) and
# fails if the working tree's `schema.graphql` does not match the
# regenerated output.
#
# This catches three classes of regression in one gate:
#
#   1. A resolver / type change in `apps/default/src` that is not
#      reflected in the committed SDL (the apps/web typegen would
#      then diverge silently).
#   2. A hand-edit of `schema.graphql` that no longer corresponds to
#      a code change (the smoke script would still pass — only the
#      typegen on the apps/web side notices, late).
#   3. ADR-0041 byte-equal SDL invariant — every rebuild must produce
#      the same bytes regardless of import order.
#
# Run via `just schema-drift-check`.

set -euo pipefail

# Re-render through the dev container so the shape is reproducible
# from any host.
docker compose run --rm dev bash -c "cd apps/default && corepack pnpm run print-schema" >/dev/null

if ! git diff --quiet -- apps/default/schema.graphql; then
  echo "schema-drift: apps/default/schema.graphql does not match the print-schema output" >&2
  echo "schema-drift: re-run \`docker compose run --rm dev bash -c 'cd apps/default && corepack pnpm run print-schema'\` and commit the result" >&2
  git --no-pager diff -- apps/default/schema.graphql >&2 || true
  exit 1
fi
echo "schema-drift: apps/default/schema.graphql is up to date"
