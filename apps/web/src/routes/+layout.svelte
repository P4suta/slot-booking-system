<script lang="ts">
  import "../app.css"
  import { page } from "$app/state"
  import { onMount } from "svelte"
  import { m } from "$lib/messages.js"

  let { children } = $props()

  // /staff owns its own page header (brand, connection status, search,
  // logout). The customer-side global header would otherwise put a
  // one-click "整理券" link to the customer landing right next to the
  // operator's tools — a footgun for tech-shy staff. Suppress the
  // global header on /staff and let the staff layout drive its own
  // chrome.
  const isStaffRoute = $derived(page.url.pathname.startsWith("/staff"))

  type Theme = "light" | "dark" | "auto"
  let theme: Theme = $state("auto")

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

{#if !isStaffRoute}
  <header>
    <nav aria-label="Primary">
      <a href="/">{m.layout_brand()}</a>
    </nav>
    <button
      type="button"
      class="theme-toggle"
      aria-label={m.layout_theme_toggle_label()}
      title={m.layout_theme_toggle_title({ theme })}
      onclick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "auto" : "dark")}
    >
      {theme === "dark" ? "☾" : theme === "light" ? "☀" : "↺"}
    </button>
  </header>
{/if}

<main class:full-height={isStaffRoute}>
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
  main.full-height {
    min-height: 100vh;
  }
</style>
