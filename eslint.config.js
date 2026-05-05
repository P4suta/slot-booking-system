// @ts-check
import tseslint from "typescript-eslint"

/**
 * ESLint flat-config (v10). Biome handles formatting + the fast
 * structural lints; this config is the **type-aware** complement that
 * Biome's TypeScript synthesiser cannot match yet (Biome v2.4 docs).
 *
 * Strict mode — every typescript-eslint preset's rule stays at its
 * default (`error`) severity. The few overrides below adapt to
 * project-specific conventions (we use `type` not `interface`, and a
 * couple of test-only deprecation warnings come from `expect-type`'s
 * internal API renaming).
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.wrangler/**",
      "**/.svelte-kit/**",
      "**/build/**",
      "**/.template/**",
      ".stryker-tmp/**",
      "packages/core/.stryker-tmp/**",
      "packages/core/reports/**",
      "apps/default/dist/**",
      // Plain JS / CJS config files outside the TypeScript projects.
      "eslint.config.js",
      "**/*.cjs",
      "**/*.config.cjs",
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // We use `type` consistently (matches Effect's surface).
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      // Allow `_unused` parameters (common in Effect callbacks).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
)
