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
/* eslint-disable @typescript-eslint/consistent-type-definitions, @typescript-eslint/no-empty-object-type */
declare global {
  namespace App {
    interface Locals {
      readonly graphqlEndpoint: string
    }
    interface PageData {}
    interface Platform {
      readonly env: {
        readonly DEPLOYMENT_TIMEZONE?: string
      }
      readonly cf?: CfProperties
      readonly ctx?: ExecutionContext
    }
  }
}

/* eslint-enable @typescript-eslint/consistent-type-definitions, @typescript-eslint/no-empty-object-type */

export {}
