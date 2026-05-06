import { builder } from "./builder.js"
// Side-effect imports — registering each resolver attaches its types
// to the shared `builder` before `toSchema()` materialises the GraphQL
// schema document.
import "./resolvers/availableSlots.js"
import "./resolvers/catalog.js"
import "./resolvers/mutations.js"
import "./resolvers/staffCatalog.js"

export const schema = builder.toSchema()
