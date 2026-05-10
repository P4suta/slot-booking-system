// dependency-cruiser config — enforces architectural invariants from
// SYSTEM.md §4.5.2 and ADRs 0008 / 0010 / 0015.
//
//   packages/core/src/domain         — pure
//   packages/core/src/application    — Effect, ports may import domain
//   packages/core/src/infrastructure — may import everything else in core
//   packages/core/src/presentation   — (none here; SvelteKit lives in apps)
//   apps/<name>/src                  — may import @booking/core and Cloudflare
module.exports = {
  forbidden: [
    {
      name: "no-domain-to-infra",
      severity: "error",
      comment: "domain/ must not depend on infrastructure/, presentation/, or apps",
      from: { path: "^packages/core/src/domain" },
      to: {
        path: "(^packages/core/src/infrastructure|^packages/core/src/presentation|^apps/)",
      },
    },
    {
      name: "no-domain-cloudflare",
      severity: "error",
      comment: "domain/ must not import any Cloudflare runtime symbol",
      from: { path: "^packages/core/src/domain" },
      to: { path: "^cloudflare:" },
    },
    {
      name: "no-application-to-infra",
      severity: "error",
      comment: "application/ may import domain/ + ports, not infra adapters",
      from: { path: "^packages/core/src/application" },
      to: {
        path: "(^packages/core/src/infrastructure|^packages/core/src/presentation|^apps/)",
      },
    },
    {
      name: "no-application-cloudflare",
      severity: "error",
      comment: "application/ must not import cloudflare:*; that lives in adapters",
      from: { path: "^packages/core/src/application" },
      to: { path: "^cloudflare:" },
    },
    {
      name: "no-circular",
      severity: "error",
      comment: "circular dependencies indicate a layering mistake",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "error",
      comment:
        "an orphan module is unused; verify or remove. Public sub-export " +
        "entries (`@booking/core/<subpath>` declared in package.json) live " +
        "in their own `index.ts` and are excluded — they are roots of the " +
        "consumer-facing graph, not internal nodes.",
      from: {
        orphan: true,
        pathNot:
          "(\\.config\\.|\\.test\\.|^test/" +
          "|apps/.*/src/worker\\.ts|apps/.*/src/server/schema\\.ts" +
          "|^packages/core/src/derive/index\\.ts" +
          "|^apps/default/seed/seed\\.ts" +
          "|^apps/default/scripts/" +
          // Integration test harness modules are imported only by
          // their sibling `*.integration.test.ts` files (which the
          // cruise considers test code, hence outside the production
          // graph). Without this exemption the harness scaffolds
          // appear as orphans the moment they land but before the
          // first test consumer wires up.
          "|^apps/.*/test/integration/_harness/.*\\.ts$" +
          // SvelteKit's file-system routing loads these by convention.
          "|^apps/web/src/routes/.*\\.svelte$" +
          "|^apps/web/src/(app\\.d\\.ts|app\\.html|app\\.css|hooks\\.server\\.ts)$" +
          // Imported by .svelte files which dep-cruiser does not parse.
          "|^apps/web/src/lib/(graphql/endpoint|graphql/client|graphql/queries|i18n|kana|qr)\\.ts$" +
          "|^apps/web/src/lib/components/.*\\.svelte$)",
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path:
        "(node_modules|dist|\\.wrangler|\\.svelte-kit|coverage|\\.turbo|apps/web/src/paraglide)",
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "default"],
      mainFields: ["module", "main"],
    },
    includeOnly: { path: "^(packages|apps)/" },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
}
