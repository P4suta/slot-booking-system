import { defineConfig } from "drizzle-kit"

// Drizzle config for the D1 binding. Phase 0 ships an empty migration
// so `wrangler d1 migrations apply DB --local` is wired but does not
// commit any schema yet — the real schema lands in Phase 1 along with
// the DurableObject `DaySchedule`.
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
