import { defineConfig } from "drizzle-kit"

// Drizzle config for the D1 binding. Migrations land under
// `apps/default/migrations/`; the live schema is `src/server/schema/`.
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/server/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID ?? "",
    token: process.env.CLOUDFLARE_API_TOKEN ?? "",
  },
})
