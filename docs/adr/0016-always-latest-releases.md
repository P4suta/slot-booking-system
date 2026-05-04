# 0016. Dependencies and tools track the latest release

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: maintenance, dependencies

## Context

A from-scratch project gives us the rare freedom to never carry legacy
versions. Pinning to "whatever was current last quarter" gradually
accumulates deprecated APIs, missed CVE patches, and Stack-Overflow
answers that no longer apply.

## Decision

- **Dependencies**: at adoption time, every npm package is recorded as
  `^<latest>` after verifying the version with `pnpm view <pkg> version`.
  Memory or training-data version numbers are **hypotheses**; only the
  registry is the truth (cf. ADR-0009 / `feedback_data_driven`).
- **GitHub Actions**: pinned by major (`uses: actions/checkout@v4`).
  Dependabot updates them weekly.
- **mise tools**: `latest`, with the user-level `mise upgrade --bump`
  systemd timer pulling weekly.
- **Dependabot**: configured for `npm`, `github-actions`, and `docker`,
  with grouped PRs for related stacks (effect-stack, cloudflare-stack,
  test-stack, lint-format, types, typescript). See
  `.github/dependabot.yml`.
- **Major-version updates** require an ADR explaining the migration —
  breaking changes deserve documentation. Patch / minor PRs land on
  green CI without a separate ADR.
- **Deprecation rule**: when a tool reports a flag / API as deprecated,
  the deprecation is fixed in the same PR or in a follow-up tracking
  issue; we do not let it linger. A recent example: TypeScript 6 listed
  `esModuleInterop:false` and `allowSyntheticDefaultImports:false` as
  deprecated; we removed them immediately rather than silencing.

## Consequences

- Continuous low-volume Dependabot churn replaces sporadic painful
  upgrade days.
- Build hygiene is enforced by the CI gate every PR (a stale dep that
  no longer typechecks fails immediately).
- The cost is transient: each minor bump consumes a bit of attention
  weekly. Grouped PRs by stack keep this under a few minutes.

## Alternatives considered

- **Pin to a specific version, upgrade on need**: standard practice for
  shipped libraries, but hostile to a single-deployment SaaS where
  "shipping the latest" is an active goal.
- **Renovate instead of Dependabot**: equally capable; Dependabot is
  GitHub-native and zero-setup. Switch is a one-line change if needed.

## References

- Memory `feedback_always_latest_releases.md`,
  `feedback_data_driven.md`.
- `.github/dependabot.yml`.
- CLAUDE.md global ("最新のモダンな技術を積極採用").
