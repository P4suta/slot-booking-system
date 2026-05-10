<script lang="ts">
  import "../app.css"
  import { goto } from "$app/navigation"
  import { onMount } from "svelte"

  let { children } = $props()

  type Theme = "light" | "dark" | "auto"
  let theme: Theme = $state("auto")

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
