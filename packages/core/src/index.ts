// Side-effect import: tightens stdlib types (`JSON.parse: unknown`,
// `array.filter(Boolean)` narrows, `Set.has(x)` narrows, …). Loaded
// from the entrypoint so every consumer of `@booking/core` inherits
// the augmented globals automatically.
import "@total-typescript/ts-reset"

export * from "./application/index.js"
export * from "./derive/index.js"
export * from "./domain/index.js"
export * from "./infrastructure/index.js"
