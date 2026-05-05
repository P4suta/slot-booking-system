import { builder } from "./builder.js"
// Side-effect imports — registering each resolver attaches its types
// to the shared `builder` before `toSchema()` materialises the GraphQL
// schema document.
import "./resolvers/availableSlots.js"

export const schema = builder.toSchema()
