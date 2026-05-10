<script lang="ts">
  // Per-instance helper id so multiple Help icons on the same page
  // each get their own aria-describedby target without colliding.
  let nextId = 0
  const localId = (): string => {
    nextId += 1
    return `help-pop-${String(nextId)}`
  }

  type Props = {
    text: string
    label?: string
  }

  let { text, label = "詳細を表示" }: Props = $props()

  let open = $state(false)
  const popoverId = localId()

  const toggle = (): void => {
    open = !open
  }

  const close = (): void => {
    open = false
  }
</script>

<span class="help-root">
  <button
    type="button"
    class="help-trigger"
    aria-label={label}
    aria-describedby={open ? popoverId : undefined}
    aria-expanded={open}
    onclick={toggle}
    onmouseleave={close}
  >
    ?
  </button>
  {#if open}
    <span
      id={popoverId}
      role="tooltip"
      class="help-popover"
    >
      {text}
    </span>
  {/if}
</span>

<style>
  .help-root {
    display: inline-block;
    position: relative;
    margin-left: var(--space-2);
  }
  .help-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius-pill);
    border: 1px solid var(--color-border-strong);
    background: var(--color-bg-subtle);
    color: var(--color-fg-secondary);
    font: var(--text-label-sm);
    cursor: pointer;
    line-height: 1;
  }
  .help-trigger:hover,
  .help-trigger:focus-visible {
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border-color: var(--color-fg-secondary);
  }
  .help-popover {
    position: absolute;
    bottom: calc(100% + var(--space-2));
    left: 50%;
    transform: translateX(-50%);
    min-width: 14rem;
    max-width: 18rem;
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    font: var(--text-body-sm);
    z-index: 10;
  }
</style>
