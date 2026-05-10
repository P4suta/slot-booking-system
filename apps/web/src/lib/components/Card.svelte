<script lang="ts">
  import type { Snippet } from "svelte"

  type Props = {
    elevated?: boolean
    interactive?: boolean
    children: Snippet
    /** Extra class names appended after `card`, for layout hooks. */
    class?: string
  }

  const {
    elevated = false,
    interactive = false,
    children,
    class: extraClass = "",
  }: Props = $props()
</script>

<div
  class="card {extraClass}"
  data-elevated={elevated ? "true" : undefined}
  data-interactive={interactive ? "true" : undefined}
>
  {@render children()}
</div>

<style>
  .card {
    background: var(--color-bg-raised);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    padding: var(--space-6);
  }
  .card[data-elevated="true"] {
    box-shadow: var(--shadow-md);
  }
  .card[data-interactive="true"] {
    cursor: pointer;
    transition: box-shadow 120ms ease, transform 120ms ease;
  }
  .card[data-interactive="true"]:hover {
    box-shadow: var(--shadow-lg);
    transform: translateY(-1px);
  }
</style>
