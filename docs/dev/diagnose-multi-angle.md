# `just diagnose-multi-angle`

The diagnose-first train's headline observability surface. Wraps
the existing 6-gate `just diagnose` aggregator and adds three
dimensions on top:

```console
$ just diagnose-multi-angle
→ typecheck
→ biome
→ eslint
→ arch
→ test
→ guards
→ wrote .diagnose/multi-angle.md
```

Open `.diagnose/multi-angle.md` for the full report. Headline:

```text
| dimension | value | target |
| --- | --- | --- |
| skip-by-TODO-tag count | 0 | 0 |
| error-tag coverage | 17 / 17 | 17 / 17 |
| silent-failure residual | 0 | 0 |
```

## What each dimension means

### skip-by-TODO-tag count

Every `it.skip(...)` / `it.todo(...)` paired with a
`TODO(diagnose-train…)` comment is a **pinned-but-unimplemented
spec entry**. The list is the operator's priority-ordered backlog;
the train's completion definition demands this counter reach 0.

### error-tag coverage matrix (17 / 17)

`errorClassRegistry` is the SoT for every `DomainError` the domain
layer can emit. The matrix walks every integration test under
`apps/default/test/integration/` and asserts which tags actually
appear in `expect.toBe("<Tag>")` clauses. The uncovered set is the
"this envelope path has no integration assertion in CI today" punch
list.

The compile-time matrix in `apps/default/test/server/http/errorEnvelope.test.ts`
is a separate guarantee: it iterates `errorClassRegistry`,
calls `statusForTag(tag)` for each, and asserts a known HTTP
status. Adding a new tag to the registry without updating the
matrix fails type-check immediately.

### silent-failure residual

Every `\.catch\(\(\) => null\)` and bare `console\.error\(` site
under `apps/` + `packages/`. The diagnose-first train's
hypothesis is that silent failures are the source of operator
blindness — the counter targets ZERO.

## When to run

- Locally before `git push` to make sure the train's invariants
  still hold.
- In CI as an informational step (the script exits 0 always; gate
  status is read from `.diagnose/multi-angle.md`).
- When debugging a customer report — the headline counters are
  often the first place to look for "what changed".
