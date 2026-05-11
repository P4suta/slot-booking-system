import { sveltekit } from "@sveltejs/kit/vite"
import { defineConfig } from "vite"

/**
 * Dev-server proxy for `/api/*` (REST + the `/queue/feed`
 * WebSocket upgrade) onto the wrangler dev worker. Without
 * `ws: true` the WS handshake never reaches the worker; without
 * same-origin proxying the `__Host-staff_session` cookie issued
 * by `POST /api/v1/staff/login` is dropped by the browser on
 * cross-origin requests (`SameSite=Strict`) — so the staff
 * Kanban WS opens anonymous and never gets the PII frame
 * variant (ADR-0083 / ADR-0085).
 *
 * Target hostname picks: from the host machine, compose publishes
 * 8787 → localhost; from the `dev-web` container, the `dev`
 * compose service resolves via the default docker network. The
 * `PUBLIC_API_PROXY_TARGET` env var overrides for one-off setups.
 *
 * Production deploys are same-origin (worker + SvelteKit share
 * the same Cloudflare zone) so the proxy only runs under
 * `vite dev`.
 */
const proxyTarget = process.env.PUBLIC_API_PROXY_TARGET ?? "http://dev:8787"

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: proxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
