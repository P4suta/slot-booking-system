<script lang="ts">
  import "../app.css"
  let { children } = $props()
</script>

<header>
  <nav aria-label="Primary">
    <a href="/">Queue</a>
  </nav>
</header>

<main>
  {@render children()}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #1d1d1f;
  }
  header {
    background: #f6f6f7;
    border-bottom: 1px solid #e2e2e2;
    padding: 0.75rem 1.5rem;
  }
  header a {
    color: inherit;
    text-decoration: none;
    font-weight: 500;
    margin-right: 1rem;
  }
  header a:hover {
    text-decoration: underline;
  }
  main {
    max-width: 64rem;
    margin: 0 auto;
    padding: 2rem 1.5rem;
  }
</style>
