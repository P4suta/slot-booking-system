<script lang="ts">
  import type { Snippet } from "svelte"
  import type { HTMLButtonAttributes } from "svelte/elements"

  type Variant = "primary" | "secondary" | "destructive" | "ghost"
  type Size = "md" | "lg"

  type Props = HTMLButtonAttributes & {
    variant?: Variant
    size?: Size
    fullWidth?: boolean
    children: Snippet
  }

  const {
    variant = "primary",
    size = "md",
    fullWidth = false,
    children,
    ...rest
  }: Props = $props()
</script>

<button
  class="btn"
  data-variant={variant}
  data-size={size}
  data-full-width={fullWidth ? "true" : undefined}
  {...rest}
>
  {@render children()}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-pill);
    padding: var(--space-3) var(--space-6);
    font: var(--text-label-md);
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .btn[data-size="lg"] {
    padding: var(--space-4) var(--space-8);
    font: var(--text-body-lg);
  }
  .btn[data-full-width="true"] {
    width: 100%;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn[data-variant="primary"] {
    background: var(--color-accent-primary);
    color: var(--color-accent-on-primary);
  }
  .btn[data-variant="primary"]:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .btn[data-variant="secondary"] {
    background: var(--color-bg-subtle);
    color: var(--color-fg-primary);
    border-color: var(--color-border-subtle);
  }
  .btn[data-variant="secondary"]:hover:not(:disabled) {
    background: var(--color-bg-raised);
  }
  .btn[data-variant="destructive"] {
    background: var(--color-state-danger);
    color: var(--color-accent-on-primary);
  }
  .btn[data-variant="destructive"]:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .btn[data-variant="ghost"] {
    background: transparent;
    color: var(--color-fg-primary);
    border-color: transparent;
  }
  .btn[data-variant="ghost"]:hover:not(:disabled) {
    background: var(--color-bg-subtle);
  }
</style>
