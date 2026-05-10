<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements"

  type Props = HTMLInputAttributes & {
    label: string
    error?: string | null
    hint?: string
    value?: string
  }

  let {
    label,
    error = null,
    hint,
    value = $bindable(""),
    id,
    ...rest
  }: Props = $props()

  const fieldId = id ?? `input-${Math.random().toString(36).slice(2, 9)}`
  const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined
</script>

<label class="field" for={fieldId}>
  <span class="label">{label}</span>
  <input
    id={fieldId}
    bind:value
    aria-invalid={error !== null ? "true" : undefined}
    aria-describedby={describedBy}
    {...rest}
  />
  {#if error !== null}
    <span class="error" id="{fieldId}-error" role="alert">{error}</span>
  {:else if hint}
    <span class="hint" id="{fieldId}-hint">{hint}</span>
  {/if}
</label>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .label {
    font: var(--text-label-md);
    color: var(--color-fg-secondary);
  }
  input {
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
  }
  input[aria-invalid="true"] {
    border-color: var(--color-state-danger);
  }
  .error {
    font: var(--text-body-sm);
    color: var(--color-state-danger);
  }
  .hint {
    font: var(--text-body-sm);
    color: var(--color-fg-muted);
  }
</style>
