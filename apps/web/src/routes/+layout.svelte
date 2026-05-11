<script lang="ts">
  import "../app.css"
  import { goto } from "$app/navigation"
  import { onMount } from "svelte"
  import { m } from "$lib/messages.js"
  import type { WsDisplayState } from "$lib/wsStatus.js"
  import { wsStatus } from "$lib/wsStatus.js"
  import {
    clearStaffSession,
    initStaffSession,
    staffSessionActive,
  } from "$lib/staffSession.js"

  let { children } = $props()

  // Resolve a single WS-status descriptor (label + tone) per
  // store value. Returns `null` for `"none"` so the layout can
  // hide the chip entirely on routes that don't subscribe to a
  // WS feed (= /issue, /recover, /staff before login). Colour
  // alone fails a11y; the visible text tells screen readers and
  // colour-blind users the same thing.
  const wsDescriptor = (
    state: WsDisplayState,
  ): { readonly text: string; readonly tone: "ok" | "pending" | "error" } | null => {
    if (state === null) return null
    switch (state.tag) {
      case "open":
        return { text: m.ws_status_open(), tone: "ok" }
      case "connecting":
        return { text: m.ws_status_connecting(), tone: "pending" }
      case "reconnecting":
        return { text: m.ws_status_reconnecting(), tone: "pending" }
      case "closed":
        return { text: m.ws_status_closed(), tone: "error" }
    }
  }

  const ws = $derived(wsDescriptor($wsStatus))

  // The header brand link bounces to `/` by default. On a device
  // that already has a customer cache or a staff token, that "/"
  // tap would render the landing frame for a tick before the
  // route's `onMount` redirected onwards — perceived as a flicker.
  // Resolve the destination synchronously from localStorage and
  // navigate via `goto` so the in-between render never happens.
  const resolveHomeDestination = (): string => {
    if (typeof window === "undefined") return "/"
    try {
      if (window.localStorage.getItem("queue.staffToken") !== null) return "/staff"
      const cached = window.localStorage.getItem("queue.ticket.v2")
      if (cached !== null) {
        const parsed = JSON.parse(cached) as { ticketId?: string }
        if (typeof parsed.ticketId === "string" && parsed.ticketId.length > 0) {
          return `/ticket?id=${encodeURIComponent(parsed.ticketId)}`
        }
      }
    } catch {
      /* localStorage may throw under private-mode quotas — fall through. */
    }
    return "/"
  }

  const onBrandClick = (event: MouseEvent): void => {
    event.preventDefault()
    void goto(resolveHomeDestination())
  }

  // Theme is OS-driven. The user feedback was: 「社内ツールに切替
  // ボタンはいらない、 環境を読み取って自動切替だけでいい」 — so
  // there is no toggle anymore. CSS's `@media (prefers-color-scheme:
  // dark)` does the work, no localStorage involved.

  const onHeaderLogout = (): void => {
    clearStaffSession()
    void goto("/")
  }

  // navigator.onLine is the simplest heuristic to tell "device is
  // disconnected" (= WiFi / airplane / data off) from "server is
  // unreachable but local network is fine" (= Cloudflare or app
  // backend outage). It does miss some failure modes — captive
  // portal, broken DNS, ISP outage that does not flip the OS-level
  // online state — but for the common case it lets us steer the
  // alert copy toward the right place to look first.
  let online = $state(true)

  const onOnline = (): void => {
    online = true
  }
  const onOffline = (): void => {
    online = false
  }

  onMount(() => {
    initStaffSession()
    online = navigator.onLine
    window.addEventListener("online", onOnline)
    window.addEventListener("offline", onOffline)
    return () => {
      window.removeEventListener("online", onOnline)
      window.removeEventListener("offline", onOffline)
    }
  })
</script>

<header>
  <nav aria-label="メイン">
    <a href="/" onclick={onBrandClick}>整理券</a>
    {#if ws !== null}
      <span class="ws-chip" data-tone={ws.tone} role="status" aria-live="polite">
        <span class="ws-dot" aria-hidden="true"></span>
        <span class="ws-text">
          <span class="ws-label">{m.ws_status_label()}:</span>
          <span class="ws-value">{ws.text}</span>
        </span>
      </span>
    {/if}
  </nav>
  {#if $staffSessionActive}
    <button type="button" class="header-logout" onclick={onHeaderLogout}>
      ログアウト
    </button>
  {/if}
</header>

<main>
  {@render children()}
</main>

{#if ws !== null && ws.tone === "error"}
  <!--
    Server connection lost. The chip in the header turns red but
    that alone is easy to miss when the page renders other
    content. A centered, floating banner makes the loss
    unmissable so the customer knows their countdown / staff
    knows the queue might be stale, without us blocking
    interaction (they can still cancel, navigate, etc.). The
    body copy is split by `online`: if the OS reports offline we
    point them at Wi-Fi / airplane mode first (most common
    cause); if the OS thinks we are online we tell them the
    server is probably the one in trouble.
  -->
  <div class="ws-alert" role="alert" aria-live="assertive">
    <span class="ws-alert-icon" aria-hidden="true">!</span>
    <div class="ws-alert-body">
      {#if !online}
        <strong>{m.ws_alert_offline_title()}</strong>
        <span>{m.ws_alert_offline_body()}</span>
      {:else}
        <strong>{m.ws_alert_server_title()}</strong>
        {#if $staffSessionActive}
          <span>
            {m.ws_alert_server_body_staff_prefix()}<a
              href="https://www.cloudflarestatus.com/"
              target="_blank"
              rel="noopener noreferrer"
              class="ws-alert-link">status.cloudflare.com</a>{m.ws_alert_server_body_staff_suffix()}
          </span>
        {:else}
          <span>{m.ws_alert_server_body()}</span>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  header {
    background: var(--color-bg-subtle);
    border-bottom: 1px solid var(--color-border-subtle);
    padding: var(--space-3) var(--space-6);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  header a {
    color: var(--color-fg-primary);
    text-decoration: none;
    font: var(--text-label-md);
  }
  header a:hover {
    text-decoration: underline;
  }
  header nav {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .ws-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-pill);
    background: var(--color-bg-raised);
    border: 1px solid var(--color-border-subtle);
    font: var(--text-label-sm);
  }
  .ws-dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: var(--radius-pill);
    background: var(--color-fg-muted);
    flex-shrink: 0;
  }
  .ws-chip[data-tone="ok"] .ws-dot {
    background: var(--color-state-serving);
  }
  .ws-chip[data-tone="pending"] .ws-dot {
    background: var(--color-state-called);
  }
  .ws-chip[data-tone="error"] .ws-dot {
    background: var(--color-state-danger);
  }
  .ws-chip[data-tone="error"] {
    background: oklch(95% 0.07 25);
    border-color: var(--color-state-danger);
  }
  .ws-label {
    color: var(--color-fg-muted);
    margin-right: var(--space-1);
  }
  .ws-value {
    color: var(--color-fg-primary);
    font-weight: 500;
  }
  @media (max-width: 32rem) {
    .ws-label {
      display: none;
    }
  }
  .ws-alert {
    position: fixed;
    bottom: var(--space-6);
    left: 50%;
    transform: translateX(-50%);
    background: oklch(95% 0.07 25);
    color: oklch(35% 0.18 25);
    border: 1px solid var(--color-state-danger);
    border-radius: var(--radius-md);
    padding: var(--space-4) var(--space-6);
    box-shadow: var(--shadow-lg);
    z-index: 200;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    max-width: min(36rem, calc(100vw - var(--space-8)));
  }
  .ws-alert-icon {
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-pill);
    background: var(--color-state-danger);
    color: var(--color-bg-surface);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 1.25rem;
    flex-shrink: 0;
  }
  .ws-alert-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font: var(--text-body-sm);
  }
  .ws-alert-body strong {
    font: var(--text-label-md);
  }
  .ws-alert-link {
    color: inherit;
    text-decoration: underline;
    font-weight: 600;
  }
  .ws-alert-link:hover {
    text-decoration: none;
  }
  .header-logout {
    background: transparent;
    border: 1px solid var(--color-border-subtle);
    color: var(--color-fg-secondary);
    border-radius: var(--radius-pill);
    padding: var(--space-2) var(--space-4);
    font: var(--text-label-sm);
    cursor: pointer;
  }
  .header-logout:hover,
  .header-logout:focus-visible {
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
  }
  main {
    min-height: calc(100vh - 4rem);
  }
</style>
