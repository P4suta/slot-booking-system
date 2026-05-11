<script lang="ts">
  /**
   * KanbanColumn — renders a single column (header + scrollable card
   * stack) for one {@link ColumnDescriptor} (S19 / ADR-0087). The
   * column is a faithful image of `descriptor`; the parent `<Kanban>`
   * picks the descriptor list and the row of column instances follows.
   */
  import type { StaffProjectionEntry } from "@booking/core"
  import type { ColumnDescriptor } from "./descriptors.js"
  import TicketCard, { type TicketAction } from "./TicketCard.svelte"

  type Props = {
    column: ColumnDescriptor
    entries: readonly StaffProjectionEntry[]
    onAction?: (action: TicketAction, entry: StaffProjectionEntry) => void
  }

  let { column, entries, onAction }: Props = $props()
</script>

<section class="col" data-tone={column.tone} data-column-id={column.id}>
  <header class="col-header">
    <h2>{column.label}</h2>
    <span class="count" aria-label="件数">{entries.length}</span>
  </header>
  <div class="cards">
    {#if entries.length === 0}
      <p class="empty">{column.emptyMessage}</p>
    {:else}
      {#each entries as entry (entry.id)}
        <TicketCard {entry} tone={column.tone} {onAction} />
      {/each}
    {/if}
  </div>
</section>

<style>
  .col {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 0;
    min-width: 0;
    gap: var(--space-3);
  }
  .col-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .col-header h2 {
    font: var(--text-label-md);
    margin: 0;
    color: var(--color-fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .count {
    font: var(--text-numeral-sm);
    font-variant-numeric: tabular-nums;
    color: var(--color-fg-primary);
    background: var(--color-bg-subtle);
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
    min-width: 2rem;
    text-align: center;
  }
  .col[data-tone="accent"] .count {
    background: oklch(95% 0.07 60 / 50%);
    color: oklch(35% 0.16 60);
  }
  .col[data-tone="warning"] .count {
    background: oklch(95% 0.08 70 / 60%);
    color: oklch(35% 0.18 70);
  }
  .col[data-tone="muted"] .count {
    color: var(--color-fg-muted);
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
    max-height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: var(--space-1);
  }
  .empty {
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
    text-align: center;
    padding: var(--space-4);
    margin: 0;
  }
</style>
