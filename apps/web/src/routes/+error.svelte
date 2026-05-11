<script lang="ts">
  /**
   * Root error boundary (Stage 24 / ADR-0094).
   *
   * Rendered by SvelteKit whenever a `+page.svelte` / `+layout.svelte`
   * load function or lifecycle throws past the route boundary, and
   * for every 4xx/5xx status produced by `handleError` (`hooks.client.ts`
   * / `hooks.server.ts`). Shows a sanitized user message plus the
   * trace id the customer can quote back to support — the upstream
   * structured-log surface (`SvelteKitSsrError` / `ClientReport`)
   * carries the same id so the operator can pivot from the trace to
   * the root cause.
   */
  import { page } from "$app/state"

  const error = $derived(page.error)
  const status = $derived(page.status)
  const traceId = $derived(error?.traceId)
</script>

<svelte:head>
  <title>エラー</title>
</svelte:head>

<div class="error-page">
  <div class="card">
    <div class="status">エラー {status}</div>
    <h1>{error?.message ?? "予期しないエラーが発生しました。"}</h1>
    {#if traceId !== undefined}
      <p class="trace">
        お問い合わせの際は次の ID をお伝えください:
        <code>{traceId}</code>
      </p>
    {/if}
    <p class="actions">
      <a href="/">トップへ戻る</a>
    </p>
  </div>
</div>

<style>
  .error-page {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4, 1rem);
    flex: 1;
    min-height: 60vh;
  }
  .card {
    max-width: 32rem;
    width: 100%;
    background: var(--bg, #fff);
    border: 1px solid var(--border, #e5e5e5);
    border-radius: 0.75rem;
    padding: 2rem 1.5rem;
    text-align: center;
  }
  .status {
    color: var(--fg-muted, #888);
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
    margin-bottom: 0.5rem;
  }
  h1 {
    margin: 0 0 1.5rem;
    font-size: 1.15rem;
    line-height: 1.5;
    color: var(--fg, #222);
  }
  .trace {
    margin: 1.5rem 0;
    font-size: 0.85rem;
    color: var(--fg-muted, #555);
  }
  .trace code {
    display: inline-block;
    margin-top: 0.4rem;
    font-family: ui-monospace, monospace;
    font-size: 0.95em;
    background: var(--bg-muted, #f4f4f4);
    border: 1px solid var(--border, #ddd);
    border-radius: 0.3em;
    padding: 0.25em 0.75em;
    user-select: all;
  }
  .actions {
    margin-top: 1.5rem;
  }
  .actions a {
    color: var(--accent, #1b4d8a);
    text-decoration: none;
    font-weight: 500;
  }
  .actions a:hover {
    text-decoration: underline;
  }
</style>
