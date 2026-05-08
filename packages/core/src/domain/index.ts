// Public surface of the domain layer. Every sub-module re-exports flatly
// at this level — value-object / error names are unique across the
// layer. Phase 1 of the queue pivot reintroduces `auth/`; Phase 1.2
// adds the queue aggregate (`queue/`) and the event log (`events/`).
export * from "./auth/index.js"
export * from "./errors/index.js"
export * from "./types/index.js"
export * from "./value-objects/index.js"
