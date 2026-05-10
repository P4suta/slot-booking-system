#!/usr/bin/env -S tsx
/**
 * comment-bans — host-side rg wrapper that rejects "historical
 * narrative" tokens from the queue-side source tree.
 *
 * Behaviour:
 *
 *   - Input paths default to `packages apps docs README.md
 *     CONTRIBUTING.md` (the queue-domain code surface). When
 *     lefthook hands explicit staged-file arguments instead, we
 *     filter them through the same allow-list `EXCLUDED_PREFIXES`
 *     uses for the full scan — `--glob '!pattern'` only filters
 *     directory traversal, not positional file args.
 *   - The actual scan happens inside the dev container so the rg
 *     binary version matches CI; the wrapper shells out to
 *     `scripts/dev-exec.ts` for that hop.
 *   - Pattern source: `scripts/lint/comment-bans.pattern`.
 *
 * Allow-list (rationale carried over from the .sh predecessor):
 * docs/adr/.* — decision archive; ADR_INDEX.md keeps phase refs.
 * CHANGELOG.md — release log. .gitleaks.toml / _typos.toml — token
 * allow-lists repeat the patterns. docs/error-codes.md — generated
 * from Errors.ts. wrangler.toml — DO migration tags are immutable
 * Cloudflare history. scripts/lint — the pattern file itself
 * contains the tokens. paraglide / dist / node_modules / .svelte-kit
 * — vendor / generated.
 */
import { spawnSync } from "node:child_process"

// Repo-relative path so the value travels verbatim through
// `dev-exec.ts` into the dev container (its WORKDIR is the
// mounted repo root). An absolute host path would not resolve
// inside the container's filesystem namespace.
const PATTERN_FILE = "scripts/lint/comment-bans.pattern"

const DEFAULT_INPUTS = ["packages", "apps", "docs", "README.md", "CONTRIBUTING.md"] as const

const EXCLUDE_GLOBS = [
  "!docs/adr/**",
  "!docs/ADR_INDEX.md",
  "!CHANGELOG.md",
  "!.gitleaks.toml",
  "!_typos.toml",
  "!docs/error-codes.md",
  "!**/wrangler.toml",
  "!scripts/lint/**",
  "!**/paraglide/**",
  "!**/dist/**",
  "!**/node_modules/**",
  "!.svelte-kit/**",
] as const

/**
 * Per-file allow-list mirror (lefthook hands ripgrep individual
 * filenames, which `--glob '!…'` does NOT filter — globs control
 * directory traversal, not positional file args). The CLI patterns
 * here echo `EXCLUDE_GLOBS`'s intent on a per-file basis.
 */
const isExcludedFile = (path: string): boolean => {
  if (path.startsWith("docs/adr/")) return true
  if (
    path === "docs/ADR_INDEX.md" ||
    path === "CHANGELOG.md" ||
    path === ".gitleaks.toml" ||
    path === "_typos.toml" ||
    path === "docs/error-codes.md"
  )
    return true
  if (path === "wrangler.toml" || path.endsWith("/wrangler.toml")) return true
  if (path.startsWith("scripts/lint/")) return true
  if (
    path.includes("/paraglide/") ||
    path.includes("/dist/") ||
    path.includes("/node_modules/") ||
    path.includes("/.svelte-kit/")
  )
    return true
  return false
}

const args = process.argv.slice(2)
const inputs: readonly string[] = (() => {
  if (args.length === 0) return DEFAULT_INPUTS
  const filtered = args.filter((p) => !isExcludedFile(p))
  if (filtered.length === 0 && args.length > 0) {
    // Every input was on the allow-list — exit 0 without invoking rg.
    process.exit(0)
  }
  return filtered
})()

const rgArgs = [
  "rg",
  "--color=never",
  "--no-heading",
  "--line-number",
  "--pcre2",
  "-f",
  PATTERN_FILE,
  ...EXCLUDE_GLOBS.flatMap((g) => ["--glob", g]),
  ...inputs,
]

const result = spawnSync("scripts/dev-exec.ts", rgArgs, {
  stdio: ["ignore", "inherit", "inherit"],
})

if (result.status === 0) {
  process.stderr.write(`
[comment-bans] historical narrative tokens detected.
The source tree should describe the present: ADRs and CHANGELOG own
the milestone trail. Either remove the phrase, move the context to
an ADR, or extend the pattern allow-list.
Pattern source: scripts/lint/comment-bans.pattern
`)
  process.exit(1)
}
// rg exits 1 when no matches found — that's the success path here.
if (result.status === 1) process.exit(0)
process.exit(result.status ?? 1)
