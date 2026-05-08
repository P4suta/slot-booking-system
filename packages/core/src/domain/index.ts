// Public surface of the domain layer. Every sub-module re-exports flatly
// at this level — entity / value-object / error / event names are unique
// across the layer. The one exception is `slot/index.ts`, which keeps
// `Bitmap` namespaced because its API is a small toolkit of generic
// names (`empty`, `full`, `and`, `or`, …) that would clash with anything.
export * from "./auth/index.js"
export * from "./booking/index.js"
export * from "./entities/index.js"
export * from "./errors/index.js"
export * from "./events/index.js"
export * from "./read/index.js"
export * from "./slot/index.js"
export * from "./types/index.js"
export * from "./value-objects/index.js"
