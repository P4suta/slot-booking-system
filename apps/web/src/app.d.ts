// SvelteKit's `App` namespace augmentation point. The boundary
// types live here so route load functions and endpoints get
// platform-aware typings.
//
// Both `noNamespace` (Biome) and `consistent-type-definitions`
// (ESLint) want `type` over `interface` / `namespace`, but
// SvelteKit's framework hooks read these as named members of an
// `App` namespace. A per-file override lets the project rule stay
// strict everywhere else without forcing a SvelteKit upstream
// change.
/* eslint-disable @typescript-eslint/consistent-type-definitions */
import type { Locale } from "./paraglide/runtime.js"

declare global {
  namespace App {
    interface Error {
      // Returned by the `handleError` hook so `+error.svelte` can
      // display the trace id to the customer alongside the
      // sanitized message (Stage 24 / ADR-0094).
      readonly message: string
      readonly traceId?: string
    }
    interface Locals {
      // Set by `hooks.server.ts` via paraglide middleware so route
      // load functions can branch on the resolved request locale
      // without rerunning the strategy chain.
      lang: Locale
    }
    interface PageData {
      readonly lang?: Locale
    }
    interface Platform {
      readonly env: {
        readonly DEPLOYMENT_TIMEZONE?: string
      }
      readonly cf?: CfProperties
      readonly ctx?: ExecutionContext
    }
  }
}

/* eslint-enable @typescript-eslint/consistent-type-definitions */
