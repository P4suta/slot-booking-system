<script lang="ts">
  import type { Snippet } from "svelte"
  import { onDestroy } from "svelte"
  import { m } from "$lib/messages.js"

  type Props = {
    open: boolean
    title: string
    onClose: () => void
    children: Snippet
    actions?: Snippet
  }

  let { open = $bindable(false), title, onClose, children, actions }: Props = $props()

  let dialogEl: HTMLDialogElement | null = $state(null)
  let lastFocus: HTMLElement | null = null

  $effect(() => {
    const el = dialogEl
    if (el === null) return
    if (open && !el.open) {
      lastFocus = (document.activeElement as HTMLElement | null) ?? null
      el.showModal()
    } else if (!open && el.open) {
      el.close()
      lastFocus?.focus()
      lastFocus = null
    }
  })

  function onCancel(event: Event) {
    event.preventDefault()
    onClose()
  }

  function onClickBackdrop(event: MouseEvent) {
    if (event.target === dialogEl) onClose()
  }

  onDestroy(() => {
    if (dialogEl?.open === true) dialogEl.close()
  })
</script>

<dialog
  bind:this={dialogEl}
  oncancel={onCancel}
  onclick={onClickBackdrop}
  aria-labelledby="dialog-title"
>
  <header>
    <h2 id="dialog-title">{title}</h2>
    <button type="button" class="close" aria-label={m.common_close_label()} onclick={onClose}>
      ×
    </button>
  </header>
  <div class="body">
    {@render children()}
  </div>
  {#if actions}
    <footer>
      {@render actions()}
    </footer>
  {/if}
</dialog>

<style>
  dialog {
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    padding: 0;
    box-shadow: var(--shadow-lg);
    max-width: min(36rem, calc(100vw - var(--space-8)));
    width: 100%;
  }
  dialog::backdrop {
    background: oklch(0% 0 0 / 50%);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-5) var(--space-6);
    border-bottom: 1px solid var(--color-border-subtle);
  }
  header h2 {
    margin: 0;
    font: var(--text-numeral-md);
  }
  .close {
    background: transparent;
    border: none;
    font-size: 1.5rem;
    line-height: 1;
    color: var(--color-fg-muted);
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-pill);
  }
  .close:hover {
    background: var(--color-bg-subtle);
    color: var(--color-fg-primary);
  }
  .body {
    padding: var(--space-6);
  }
  footer {
    padding: var(--space-4) var(--space-6) var(--space-6);
    display: flex;
    gap: var(--space-3);
    justify-content: flex-end;
    border-top: 1px solid var(--color-border-subtle);
  }
</style>
