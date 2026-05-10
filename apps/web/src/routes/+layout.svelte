<script lang="ts">
  import "../app.css"
  import { goto } from "$app/navigation"
  import { onMount } from "svelte"
  import { m } from "$lib/messages.js"
  import { wsStatus } from "$lib/wsStatus.js"
  import type { QueueFeedState } from "$lib/api.js"

  let { children } = $props()

  type Theme = "light" | "dark" | "auto"
  let theme: Theme = $state("auto")

  // Resolve a single WS-status descriptor (label + tone) per
  // QueueFeedState value. Color alone fails a11y; the visible text
  // tells screen readers and colour-blind users the same thing.
  const wsDescriptor = (
    state: QueueFeedState,
  ): { readonly text: string; readonly tone: "ok" | "pending" | "error" } => {
    switch (state) {
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

  // Theme persistence: localStorage > prefers-color-scheme. The
  // CSS layer handles the fallback (`@media (prefers-color-scheme:
  // dark)` only fires when [data-theme] is not "light"), so the
  // body attribute is set only for the explicit overrides.
  const applyTheme = (next: Theme): void => {
    if (typeof document === "undefined") return
    if (next === "auto") {
      document.documentElement.removeAttribute("data-theme")
    } else {
      document.documentElement.setAttribute("data-theme", next)
    }
  }

  const setTheme = (next: Theme): void => {
    theme = next
    applyTheme(next)
    if (typeof window !== "undefined") {
      if (next === "auto") localStorage.removeItem("queue.theme")
      else localStorage.setItem("queue.theme", next)
    }
  }

  onMount(() => {
    const stored = localStorage.getItem("queue.theme")
    if (stored === "dark" || stored === "light") {
      theme = stored
      applyTheme(stored)
    }
  })
</script>

<header>
  <nav aria-label="メイン">
    <a href="/" onclick={onBrandClick}>整理券</a>
    <span class="ws-chip" data-tone={ws.tone} role="status" aria-live="polite">
      <span class="ws-dot" aria-hidden="true"></span>
      <span class="ws-text">
        <span class="ws-label">{m.ws_status_label()}:</span>
        <span class="ws-value">{ws.text}</span>
      </span>
    </span>
  </nav>
  <button
    type="button"
    class="theme-toggle"
    aria-label={theme === "dark" ? "テーマ切替 (現在: ダーク)" : theme === "light" ? "テーマ切替 (現在: ライト)" : "テーマ切替 (現在: 自動)"}
    title={theme === "dark" ? "テーマ: ダーク (タップでライトに)" : theme === "light" ? "テーマ: ライト (タップで自動に)" : "テーマ: 自動 (タップでダークに)"}
    onclick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "auto" : "dark")}
  >
    {theme === "dark" ? "☾" : theme === "light" ? "☀" : "↺"}
  </button>
</header>

<main>
  {@render children()}
</main>

{#if ws.tone === "error"}
  <!--
    Server connection lost. The chip in the header turns red but
    that alone is easy to miss when the page renders other
    content. A centered, floating banner makes the loss
    unmissable so the customer knows their countdown / staff
    knows the queue might be stale, without us blocking
    interaction (they can still cancel, navigate, etc.).
  -->
  <div class="ws-alert" role="alert" aria-live="assertive">
    <span class="ws-alert-icon" aria-hidden="true">!</span>
    <div class="ws-alert-body">
      <strong>{m.ws_status_closed()}</strong>
      <span>表示が古い可能性があります。 復旧をお待ちください。</span>
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
  .theme-toggle {
    background: transparent;
    border: 1px solid var(--color-border-subtle);
    color: var(--color-fg-primary);
    border-radius: var(--radius-pill);
    width: 2.5rem;
    height: 2.5rem;
    font-size: 1.1rem;
    cursor: pointer;
  }
  .theme-toggle:hover {
    background: var(--color-bg-raised);
  }
  main {
    min-height: calc(100vh - 4rem);
  }
</style>
