<script lang="ts">
  import type { Snippet } from "svelte"

  type Props = {
    /** Domain error tag (`InvalidNameKana`, `PhoneMismatch`, …). */
    tag: string
    /** Error code (`E_VAL_NAME_KANA`, …). */
    code?: string
    /** Customer-facing message (i18n-resolved by the caller). */
    message: string
    /** Optional retry action label + callback. */
    retryLabel?: string
    onRetry?: () => void
    /** Optional dismiss / cancel action. */
    cancelLabel?: string
    onCancel?: () => void
    /** Additional details (form-field-level diagnostics). */
    details?: Snippet
  }

  const {
    tag,
    code,
    message,
    retryLabel,
    onRetry,
    cancelLabel,
    onCancel,
    details,
  }: Props = $props()
</script>

<div class="error-card" role="alert">
  <div class="header">
    <span class="icon" aria-hidden="true">!</span>
    <div class="text">
      <strong class="tag">{tag}</strong>
      <span class="message">{message}</span>
    </div>
  </div>
  {#if details}
    <div class="details">
      {@render details()}
    </div>
  {/if}
  {#if code !== undefined}
    <div class="code">{code}</div>
  {/if}
  {#if retryLabel !== undefined || cancelLabel !== undefined}
    <div class="actions">
      {#if cancelLabel !== undefined && onCancel !== undefined}
        <button type="button" class="btn ghost" onclick={onCancel}>{cancelLabel}</button>
      {/if}
      {#if retryLabel !== undefined && onRetry !== undefined}
        <button type="button" class="btn primary" onclick={onRetry}>{retryLabel}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .error-card {
    background: var(--color-bg-raised);
    border: 1px solid var(--color-state-danger);
    border-radius: var(--radius-md);
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .header {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
  }
  .icon {
    background: var(--color-state-danger);
    color: var(--color-accent-on-primary);
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius-pill);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font: var(--text-label-md);
    flex-shrink: 0;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .tag {
    font: var(--text-label-md);
    color: var(--color-state-danger);
  }
  .message {
    font: var(--text-body-md);
    color: var(--color-fg-primary);
  }
  .details {
    font: var(--text-body-sm);
    color: var(--color-fg-secondary);
  }
  .code {
    font: var(--text-mono-sm);
    color: var(--color-fg-muted);
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
  .btn {
    border: 1px solid transparent;
    border-radius: var(--radius-pill);
    padding: var(--space-2) var(--space-4);
    font: var(--text-label-sm);
    cursor: pointer;
  }
  .btn.ghost {
    background: transparent;
    color: var(--color-fg-primary);
  }
  .btn.ghost:hover {
    background: var(--color-bg-subtle);
  }
  .btn.primary {
    background: var(--color-accent-primary);
    color: var(--color-accent-on-primary);
  }
  .btn.primary:hover {
    filter: brightness(1.08);
  }
</style>
