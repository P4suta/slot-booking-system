<script lang="ts">
  /**
   * TicketCard — single ticket card rendered inside a Kanban column
   * (S19 / ADR-0087). The component is a pure projection of a
   * {@link StaffProjectionEntry} plus a {@link ColumnTone} discriminator
   * that drives the visual variant; all mutating intents are funneled
   * through the optional `onAction` callback so the parent page owns
   * the API call and toast / undo wiring.
   *
   * The action set is a function of `entry.state`: the
   * (state, possible-actions) relation is encoded in the switch below
   * rather than as a flag-soup, so adding a new action ⇔ extending the
   * `TicketAction` union + one switch arm.
   */
  import type { StaffProjectionEntry } from "@booking/core"
  import Card from "../Card.svelte"
  import type { ColumnTone } from "./descriptors.js"

  export type TicketAction = "call" | "served" | "noShow" | "cancel" | "recall"

  type Props = {
    entry: StaffProjectionEntry
    tone: ColumnTone
    onAction?: (action: TicketAction, entry: StaffProjectionEntry) => void
  }

  let { entry, tone, onAction }: Props = $props()

  const laneLabel: Record<StaffProjectionEntry["lane"], string> = {
    walkIn: "通常",
    priority: "優先",
    reservation: "予約",
  }

  const stateLabel: Record<StaffProjectionEntry["state"], string> = {
    Waiting: "待機中",
    Called: "呼び出し中",
    PendingNoShow: "催促中",
    Served: "対応完了",
    NoShow: "来店なし",
    Cancelled: "キャンセル",
  }

  const dispatch = (action: TicketAction): void => {
    onAction?.(action, entry)
  }
</script>

<Card>
  <div class="ticket-card" data-tone={tone} data-state={entry.state} data-ticket-id={entry.id}>
    <header class="ticket-head">
      <div class="numeral-block">
        <span class="block-caption">整理券番号</span>
        <span class="numeral">{entry.displaySeq}</span>
      </div>
      <span class="lane-badge" data-lane={entry.lane}>{laneLabel[entry.lane]}</span>
    </header>

    <div class="ticket-body">
      <div class="kana-block">
        <span class="block-caption">お名前</span>
        <span class="kana">{entry.nameKana}</span>
      </div>
      <div class="last4-block">
        <span class="block-caption">電話末尾</span>
        <span class="last4">{entry.phoneLast4}</span>
      </div>
    </div>

    <footer class="ticket-foot">
      <span class="state-badge" data-state={entry.state}>{stateLabel[entry.state]}</span>
      {#if entry.appointmentAt !== null}
        <span class="slot-chip">
          <span class="slot-chip-label">予約</span>
          <span class="slot-chip-time">{entry.appointmentAt.slice(11, 16)}</span>
        </span>
      {/if}
    </footer>

    {#if onAction !== undefined}
      <div class="actions">
        {#if entry.state === "Waiting"}
          <button type="button" class="action primary" onclick={() => dispatch("call")}>
            呼び出し
          </button>
        {:else if entry.state === "Called"}
          <button type="button" class="action primary" onclick={() => dispatch("served")}>
            対応開始
          </button>
          <button type="button" class="action" onclick={() => dispatch("noShow")}>
            未応答
          </button>
          <button type="button" class="action ghost" onclick={() => dispatch("recall")}>
            呼び戻し
          </button>
        {:else if entry.state === "PendingNoShow"}
          <button type="button" class="action danger" onclick={() => dispatch("cancel")}>
            キャンセル
          </button>
        {/if}
      </div>
    {/if}
  </div>
</Card>

<style>
  .ticket-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .ticket-card[data-tone="accent"] {
    border-left: 3px solid var(--color-accent-primary);
    padding-left: var(--space-3);
    margin-left: calc(-1 * var(--space-3));
  }
  .ticket-card[data-tone="warning"] {
    border-left: 3px solid oklch(75% 0.18 80);
    padding-left: var(--space-3);
    margin-left: calc(-1 * var(--space-3));
  }
  .ticket-card[data-tone="muted"] {
    opacity: 0.75;
  }
  .ticket-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .numeral-block,
  .kana-block,
  .last4-block {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
  }
  .block-caption {
    font: var(--text-label-sm);
    color: var(--color-fg-muted);
    letter-spacing: 0.05em;
  }
  .numeral {
    font: var(--text-numeral-md);
    font-variant-numeric: tabular-nums;
    color: var(--color-fg-primary);
  }
  .lane-badge {
    font: var(--text-label-sm);
    background: var(--color-bg-subtle);
    color: var(--color-fg-secondary);
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
  }
  .lane-badge[data-lane="priority"] {
    background: oklch(95% 0.07 65 / 50%);
    color: oklch(40% 0.13 65);
  }
  .lane-badge[data-lane="reservation"] {
    background: oklch(95% 0.05 240 / 60%);
    color: oklch(40% 0.13 240);
  }
  .ticket-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .kana {
    font: var(--text-body-md);
    color: var(--color-fg-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .last4 {
    font: var(--text-mono-sm);
    font-variant-numeric: tabular-nums;
    color: var(--color-fg-primary);
  }
  .ticket-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .state-badge {
    font: var(--text-label-sm);
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
    background: var(--color-bg-subtle);
    color: var(--color-fg-secondary);
  }
  .state-badge[data-state="Served"] {
    background: oklch(95% 0.07 145);
    color: oklch(35% 0.13 145);
  }
  .state-badge[data-state="Cancelled"] {
    background: var(--color-bg-subtle);
    color: var(--color-fg-muted);
  }
  .state-badge[data-state="NoShow"] {
    background: oklch(95% 0.07 25);
    color: var(--color-state-danger);
  }
  .state-badge[data-state="Called"],
  .state-badge[data-state="PendingNoShow"] {
    background: oklch(95% 0.08 70);
    color: oklch(35% 0.16 70);
  }
  .slot-chip {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
    font: var(--text-mono-sm);
    color: var(--color-fg-secondary);
    background: var(--color-bg-subtle);
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
  }
  .slot-chip-label {
    font: var(--text-label-sm);
    color: var(--color-fg-muted);
    font-family: inherit;
  }
  .slot-chip-time {
    font-variant-numeric: tabular-nums;
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .action {
    flex: 1 1 auto;
    min-width: 6rem;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border-strong);
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    font: var(--text-label-md);
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .action:hover,
  .action:focus-visible {
    background: var(--color-bg-subtle);
    border-color: var(--color-fg-secondary);
  }
  .action.primary {
    background: var(--color-accent-primary);
    color: var(--color-accent-on-primary);
    border-color: transparent;
  }
  .action.primary:hover,
  .action.primary:focus-visible {
    filter: brightness(1.05);
  }
  .action.ghost {
    background: transparent;
  }
  .action.danger {
    background: var(--color-state-danger);
    color: var(--color-accent-on-primary);
    border-color: transparent;
  }
</style>
