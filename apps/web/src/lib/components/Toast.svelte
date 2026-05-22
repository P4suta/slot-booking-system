<script lang="ts">
  import { onDestroy, onMount } from "svelte"
  import { m } from "$lib/messages.js"

  type Variant = "info" | "success" | "warning" | "danger"

  type Props = {
    message: string
    variant?: Variant
    durationMs?: number
    undoLabel?: string
    onUndo?: () => void
    onDismiss: () => void
  }

  const {
    message,
    variant = "info",
    durationMs = 5000,
    undoLabel,
    onUndo,
    onDismiss,
  }: Props = $props()

  let timer: ReturnType<typeof setTimeout> | null = null

  onMount(() => {
    if (durationMs > 0) {
      timer = setTimeout(onDismiss, durationMs)
    }
  })

  onDestroy(() => {
    if (timer !== null) clearTimeout(timer)
  })

  const handleUndo = () => {
    if (timer !== null) clearTimeout(timer)
    onUndo?.()
    onDismiss()
  }
</script>

<div class="toast" data-variant={variant} role="status" aria-live="polite">
  <span class="message">{message}</span>
  {#if undoLabel !== undefined && onUndo !== undefined}
    <button type="button" class="undo" onclick={handleUndo}>{undoLabel}</button>
  {/if}
  <button type="button" class="dismiss" aria-label={m.common_close_label()} onclick={onDismiss}>
    ×
  </button>
</div>

<style>
  .toast {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--color-bg-inverted);
    color: var(--color-fg-inverted);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    box-shadow: var(--shadow-lg);
    max-width: 28rem;
  }
  .toast[data-variant="success"] {
    background: var(--color-state-serving);
    color: oklch(15% 0 0);
  }
  .toast[data-variant="warning"] {
    background: var(--color-state-called);
    color: oklch(15% 0 0);
  }
  .toast[data-variant="danger"] {
    background: var(--color-state-danger);
    color: oklch(99% 0 0);
  }
  .message {
    font: var(--text-body-md);
  }
  .undo,
  .dismiss {
    background: transparent;
    border: 1px solid currentColor;
    color: inherit;
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
    font: var(--text-label-sm);
  }
  .dismiss {
    border: none;
    padding: 0 var(--space-2);
    font-size: 1.2rem;
    line-height: 1;
  }
  .undo:hover,
  .dismiss:hover {
    filter: brightness(1.1);
  }
</style>
