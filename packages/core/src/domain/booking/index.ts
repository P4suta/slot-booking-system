export * from "./Booking.js"
export * from "./Command.js"
// `machine.ts` is the type-level transition lattice; consumers
// usually reach for the runtime types in `transitions.ts`. Exposing
// `BookingMachineState` / `TransitionTable` from the same surface
// lets external visualisers (DOT/Mermaid emitters) reach the spec
// without a deep-import.
export * from "./machine.js"
export * from "./transitions.js"
