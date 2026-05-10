<script lang="ts">
  import { untrack } from "svelte"
  import { listSlots, type SlotEntry } from "$lib/api.js"
  import {
    defaultDateTabs,
    labelOfBucket,
    parseSlotInstant,
    slotInstantOf,
    type DateIso,
    type Granularity,
  } from "$lib/slotTime.js"

  type Props = {
    selectedISO?: string | null
    onSelect: (iso: string) => void
    granularity?: Granularity
    enabled?: boolean
  }

  let {
    selectedISO = null,
    onSelect,
    granularity = 30,
    enabled = true,
  }: Props = $props()

  const dateTabs = defaultDateTabs()

  // Initial date tab follows the inbound selection at mount; subsequent
  // user clicks on the date tabs are intentionally local. `untrack`
  // makes that one-shot read explicit (svelte-check otherwise warns).
  const initialDate: DateIso = untrack(
    () => parseSlotInstant(selectedISO, granularity)?.date ?? dateTabs[0].iso,
  )

  let selectedDate: DateIso = $state(initialDate)
  let slots: readonly SlotEntry[] = $state([])
  let slotsLoading = $state(false)
  let slotsLoaded = $state(false)

  const parsedSelection = $derived(parseSlotInstant(selectedISO, granularity))

  const ensureSlotsLoaded = async (): Promise<void> => {
    if (slotsLoaded || slotsLoading) return
    slotsLoading = true
    try {
      const result = await listSlots({
        from: dateTabs[0].iso,
        to: dateTabs[dateTabs.length - 1].iso,
        granularity,
      })
      if (result.ok) slots = result.value.slots
      slotsLoaded = true
    } finally {
      slotsLoading = false
    }
  }

  $effect(() => {
    if (enabled) void ensureSlotsLoaded()
  })

  const slotsForDate = (date: DateIso): readonly SlotEntry[] =>
    slots.filter((s) => s.date === date && s.granularity === granularity)

  const isHighlighted = (date: DateIso, bucketId: number): boolean =>
    parsedSelection !== null &&
    parsedSelection.date === date &&
    parsedSelection.bucketId === bucketId
</script>

<div class="date-tabs" role="tablist">
  {#each dateTabs as tab (tab.iso)}
    <button
      type="button"
      class:active={selectedDate === tab.iso}
      class="date-tab"
      role="tab"
      aria-selected={selectedDate === tab.iso}
      onclick={() => {
        selectedDate = tab.iso
      }}
    >
      {tab.label}
    </button>
  {/each}
</div>

{#if slotsLoading}
  <p class="loading">空き枠を読み込み中…</p>
{:else if slotsForDate(selectedDate).length === 0}
  <p class="empty">空き枠はありません</p>
{:else}
  <div class="slot-grid">
    {#each slotsForDate(selectedDate) as slot (`${slot.date}-${slot.bucketId}`)}
      <button
        type="button"
        class:selected={isHighlighted(slot.date, slot.bucketId)}
        class:full={slot.available === 0}
        class="slot-cell"
        disabled={slot.available === 0}
        aria-label={slot.available === 0
          ? `${labelOfBucket(slot.bucketId, granularity)} 満席`
          : `${labelOfBucket(slot.bucketId, granularity)} 残り ${slot.available} 枠`}
        onclick={() => onSelect(slotInstantOf(slot.date, slot.bucketId, granularity))}
      >
        <span class="slot-time">{labelOfBucket(slot.bucketId, granularity)}</span>
        <span class="slot-meta">
          {slot.available === 0 ? "満席" : `残${slot.available}`}
        </span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .date-tabs {
    display: flex;
    gap: var(--space-2);
  }
  .date-tab {
    flex: 1;
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
  }
  .date-tab.active {
    background: var(--color-bg-accent);
    color: var(--color-fg-on-accent);
    border-color: var(--color-bg-accent);
  }
  .slot-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
  .slot-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-1);
    cursor: pointer;
  }
  .slot-cell.selected {
    background: var(--color-bg-accent);
    color: var(--color-fg-on-accent);
    border-color: var(--color-bg-accent);
  }
  .slot-cell.full {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .slot-time {
    font: var(--text-label-md);
  }
  .slot-meta {
    font: var(--text-body-sm);
    color: var(--color-fg-muted);
  }
  .slot-cell.selected .slot-meta {
    color: var(--color-fg-on-accent);
  }
  .loading,
  .empty {
    margin: var(--space-3) 0 0;
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
  }
</style>
