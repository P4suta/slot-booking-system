<script lang="ts">
  import type { Ticket } from "$lib/api.js"
  import { m, stepperStepLabel } from "$lib/messages.js"
  import { computeSteps, stepperProgress } from "./stepperLogic.js"

  type Props = {
    ticket: Ticket
    variant?: "full" | "compact"
  }

  let { ticket, variant = "full" }: Props = $props()

  const steps = $derived(computeSteps(ticket))
  const progress = $derived(stepperProgress(steps))
</script>

<ol
  class="stepper"
  data-variant={variant}
  aria-label={m.stepper_aria_label()}
  style="--progress: {progress};"
>
  {#each steps as step, idx (idx)}
    <li
      class="step"
      data-col={step.column}
      data-status={step.status}
      data-danger={step.isDanger ? "true" : "false"}
      aria-current={step.status === "current" ? "step" : undefined}
    >
      <span class="dot" aria-hidden="true"></span>
      <span class="label">
        {step.terminalLabel ?? stepperStepLabel(step.key)}
      </span>
      {#if step.nudgeCount > 0}
        <span
          class="nudge-badge"
          aria-label={m.stepper_nudge_badge_aria({ count: String(step.nudgeCount) })}
        >
          {step.nudgeCount}
        </span>
      {/if}
    </li>
  {/each}
</ol>

<style>
  /* Fixed 4-column grid so a column always maps to the same milestone:
   *   col 1 = 受付 / 予約   col 2 = 到着 (reservation only)
   *   col 3 = 呼出         col 4 = 完了 / 終端ラベル
   * Walk-in cards leave col 2 empty; the connector line below still
   * spans col 1 center → col 4 center, so every dot lands at the same
   * x in a vertical stack of mixed-lane cards. */
  .stepper {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    align-items: start;
    list-style: none;
    margin: 0;
    padding: 0;
    position: relative;
  }
  /* base track: col 1 center (12.5%) → col 4 center (87.5%) */
  .stepper::before {
    content: "";
    position: absolute;
    top: 0.5rem;
    left: 12.5%;
    right: 12.5%;
    height: 2px;
    background: var(--color-border-strong);
    transform: translateY(-50%);
    z-index: 0;
  }
  /* done overlay: --progress in [0..1] driven by inline style */
  .stepper::after {
    content: "";
    position: absolute;
    top: 0.5rem;
    left: 12.5%;
    width: calc(75% * var(--progress, 0));
    height: 2px;
    background: var(--color-state-serving);
    transform: translateY(-50%);
    z-index: 0;
  }
  .step {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    text-align: center;
    min-width: 0;
  }
  .step[data-col="1"] { grid-column: 1; }
  .step[data-col="2"] { grid-column: 2; }
  .step[data-col="3"] { grid-column: 3; }
  .step[data-col="4"] { grid-column: 4; }
  .dot {
    position: relative;
    z-index: 1;
    width: 1rem;
    height: 1rem;
    border-radius: var(--radius-pill);
    border: 2px solid var(--color-border-strong);
    background: var(--color-bg-base);
    box-sizing: border-box;
  }
  .step[data-status="done"] .dot {
    background: var(--color-state-serving);
    border-color: var(--color-state-serving);
  }
  .step[data-status="current"] .dot {
    background: var(--color-state-called);
    border-color: var(--color-state-called);
    box-shadow: 0 0 0 4px var(--color-state-called-bg-soft);
  }
  .step[data-status="current"][data-danger="true"] .dot {
    background: var(--color-state-danger-border-soft);
    border-color: var(--color-state-danger-border-soft);
    box-shadow: 0 0 0 4px var(--color-state-danger-bg-soft);
  }
  .step[data-status="terminal"] .dot {
    border-color: var(--color-fg-muted);
    background:
      linear-gradient(
        135deg,
        var(--color-fg-muted) 0%,
        var(--color-fg-muted) 50%,
        var(--color-bg-subtle) 50%,
        var(--color-bg-subtle) 100%
      );
  }
  .label {
    font: var(--text-label-sm);
    color: var(--color-fg-muted);
  }
  .step[data-status="current"] .label {
    color: var(--color-fg-primary);
    font-weight: 600;
  }
  .step[data-status="current"][data-danger="true"] .label {
    color: var(--color-state-danger-fg-soft);
  }
  .step[data-status="done"] .label {
    color: var(--color-fg-secondary);
  }
  .step[data-status="terminal"] .label {
    color: var(--color-fg-muted);
    font-weight: 500;
  }
  .nudge-badge {
    position: absolute;
    top: -0.5rem;
    left: calc(50% + 0.5rem);
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.25rem;
    border-radius: var(--radius-pill);
    background: var(--color-state-danger-border-soft);
    color: var(--color-fg-inverted);
    font: var(--text-label-sm);
    font-weight: 700;
    line-height: 1.25rem;
    text-align: center;
    z-index: 2;
  }

  /* compact variant: smaller dots, sr-only labels. Track and overlay
   * follow the smaller dot's center so the line stays mid-dot. */
  .stepper[data-variant="compact"] .step {
    gap: 0;
  }
  .stepper[data-variant="compact"] .dot {
    width: 0.625rem;
    height: 0.625rem;
    border-width: 2px;
  }
  .stepper[data-variant="compact"]::before,
  .stepper[data-variant="compact"]::after {
    top: 0.3125rem;
  }
  .stepper[data-variant="compact"] .step[data-status="current"] .dot {
    box-shadow: 0 0 0 2px var(--color-state-called-bg-soft);
  }
  .stepper[data-variant="compact"] .step[data-status="current"][data-danger="true"] .dot {
    box-shadow: 0 0 0 2px var(--color-state-danger-bg-soft);
  }
  .stepper[data-variant="compact"] .label {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .stepper[data-variant="compact"] .nudge-badge {
    top: -0.375rem;
    left: calc(50% + 0.25rem);
    min-width: 0.875rem;
    height: 0.875rem;
    font-size: 0.625rem;
    line-height: 0.875rem;
  }
</style>
