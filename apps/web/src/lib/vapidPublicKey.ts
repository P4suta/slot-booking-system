/**
 * Resolve the VAPID public key (ADR-0073) for the runtime
 * deployment. The public key is the URL-safe base64 of the raw
 * uncompressed P-256 point; it's safe to embed in client-side code
 * because anyone with it can only *verify* a push, not sign one.
 *
 * Sourced from `PUBLIC_VAPID_PUBLIC_KEY` (Vite-style env var) so
 * a Pages deployment can rotate the pair without rebuilding the
 * core bundle. Returns `null` when unset; the push subscribe flow
 * silently degrades to the WebSocket-only transport in that case.
 */
export const vapidPublicKey = (): string | null => {
  if (typeof window === "undefined") return null
  const v = (import.meta.env.PUBLIC_VAPID_PUBLIC_KEY as string | undefined) ?? null
  if (v === null || v.length === 0) return null
  return v
}
