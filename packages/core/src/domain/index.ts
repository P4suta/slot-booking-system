// Public surface of the domain layer. Every sub-module re-exports flatly
// at this level — value-object / error names are unique across the
// layer. Phase 1 of the queue pivot reintroduces `auth/`, `events/`,
// and the queue aggregate (`queue/`) here.
export * from "./errors/index.js"
export * from "./types/index.js"
export * from "./value-objects/index.js"
