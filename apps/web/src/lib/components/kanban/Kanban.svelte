<script lang="ts">
  /**
   * Kanban — the 5-column staff board (S19 / ADR-0087). The component
   * is a fold over the static {@link COLUMNS} descriptor table: each
   * descriptor projects out its entries from the {@link StaffShopState}
   * and renders one {@link KanbanColumn}. Adding / removing /
   * reordering columns ⇔ editing `descriptors.ts`.
   */
  import type { StaffProjectionEntry, StaffShopState } from "@booking/core"
  import { COLUMNS, entriesFor } from "./descriptors.js"
  import KanbanColumn from "./KanbanColumn.svelte"
  import type { TicketAction } from "./TicketCard.svelte"

  type Props = {
    state: StaffShopState
    onAction?: (action: TicketAction, entry: StaffProjectionEntry) => void
  }

  let { state, onAction }: Props = $props()
</script>

<div class="kanban" role="region" aria-label="店舗管理ボード">
  {#each COLUMNS as column (column.id)}
    <KanbanColumn {column} entries={entriesFor(state, column)} {onAction} />
  {/each}
</div>

<style>
  .kanban {
    display: grid;
    grid-template-columns: repeat(5, minmax(16rem, 1fr));
    grid-auto-rows: 1fr;
    gap: var(--space-4);
    flex: 1;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
  @media (max-width: 72rem) {
    .kanban {
      grid-template-columns: repeat(5, minmax(16rem, 22rem));
    }
  }
  @media (max-width: 48rem) {
    .kanban {
      grid-template-columns: 1fr;
      grid-auto-rows: minmax(14rem, auto);
      overflow-x: hidden;
      overflow-y: auto;
    }
  }
</style>
