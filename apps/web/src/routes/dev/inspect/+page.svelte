<script lang="ts">
  /**
   * /dev/inspect — 4-pane observability surface (Stage 23 /
   * ADR-0092).
   *
   * Live cross-section of every signal the obs sprint added:
   *
   *   Ring   : client obsBus snapshot (every DevEvent emitted in
   *            this session, FetchStart/End/Error, WsFrame*, etc.)
   *   Stream : server structured-log relay over WS (HttpRequest,
   *            HttpEnvelope, ClientReport, AlarmSweep)
   *   State  : current `shopStateStore.value` projection
   *   Detail : full JSON of whichever row is selected in any pane
   *
   * Build-time gated through `+page.ts` (loaded only in `vite
   * dev`); runtime gated through `IS_DEV === "1"` on the server
   * route. Both gates fail-closed independently.
   */
  import { onMount } from "svelte"
  import type { DevEventWithSeverity } from "$lib/obs/events.js"
  import { obsBus } from "$lib/obs/bus.js"
  import { shopStateStore } from "$lib/stores/shopState.svelte.js"
  import {
    devLogStream,
    startDevLogStream,
    type DevLogEntry,
  } from "$lib/dev/devLogStream.svelte.js"
  import {
    devInspectorState,
    selectRingEntry,
    selectStreamEntry,
    selectShopState,
    clearSelection,
  } from "$lib/dev/devInspectorState.svelte.js"

  let ringSnapshot = $state<readonly DevEventWithSeverity[]>([])

  onMount(() => {
    ringSnapshot = obsBus.snapshot()
    const unsubscribe = obsBus.subscribe(() => {
      ringSnapshot = obsBus.snapshot()
    })
    const dispose = startDevLogStream()
    return () => {
      unsubscribe()
      dispose()
      clearSelection()
    }
  })

  const formatTime = (ms: number): string => new Date(ms).toISOString().slice(11, 23)

  const ringSummary = (event: DevEventWithSeverity): string => {
    switch (event.kind) {
      case "FetchStart":
      case "FetchEnd":
      case "FetchError":
        return `${event.method} ${event.path}`
      case "WsFrameIn":
        return `${event.capability}/${event.frameKind} (${String(event.bytes)}b)`
      case "WsClose":
        return `code=${String(event.code)} ${event.reason}`
      case "WsError":
        return event.reason
      case "StoreMutation":
        return `${event.store}: ${event.summary}`
      case "UncaughtError":
        return event.message
      case "Lifecycle":
        return `${event.phase}: ${event.route}`
      case "WsOpen":
        return ""
    }
  }

  const detail = $derived.by((): unknown => {
    const sel = devInspectorState.selection
    if (sel === null) return null
    if (sel.tag === "ring") return ringSnapshot[sel.index] ?? null
    if (sel.tag === "stream") {
      const entry = devLogStream.entries[sel.index]
      if (entry === undefined) return null
      try {
        return { ...entry, parsed: JSON.parse(entry.line) as unknown }
      } catch {
        return entry
      }
    }
    return shopStateStore.value
  })

  const selectionLabel = $derived.by((): string => {
    const sel = devInspectorState.selection
    if (sel === null) return "—"
    if (sel.tag === "ring") return `Ring[${String(sel.index)}]`
    if (sel.tag === "stream") return `Stream[${String(sel.index)}]`
    return "State (live projection)"
  })

  const streamStatusLabel = $derived.by((): string => {
    switch (devLogStream.status) {
      case "connecting":
        return "接続中…"
      case "open":
        return "接続中"
      case "closed":
        return "切断"
    }
  })

  const streamPreview = (entry: DevLogEntry): string =>
    entry.line.length > 100 ? `${entry.line.slice(0, 100)}…` : entry.line

  const isRingSelected = (index: number): boolean => {
    const sel = devInspectorState.selection
    return sel !== null && sel.tag === "ring" && sel.index === index
  }

  const isStreamSelected = (index: number): boolean => {
    const sel = devInspectorState.selection
    return sel !== null && sel.tag === "stream" && sel.index === index
  }

  const isStateSelected = $derived(devInspectorState.selection?.tag === "state")
</script>

<svelte:head>
  <title>Dev Inspector</title>
</svelte:head>

<div class="inspect">
  <header class="inspect-head">
    <h1>Dev Inspector</h1>
    <p class="hint">
      Build <code>vite dev</code> + server <code>IS_DEV=1</code> 限定。
      Ring / Stream / State / Detail を 1 画面で観察。
    </p>
  </header>

  <div class="grid">
    <section class="pane" aria-label="Ring (client obsBus)">
      <header>
        <h2>Ring</h2>
        <span class="count">{ringSnapshot.length} events</span>
      </header>
      <ul class="rows">
        {#each ringSnapshot as event, i (i)}
          <li>
            <button
              type="button"
              class="row severity-{event.severity}"
              class:selected={isRingSelected(i)}
              onclick={() => selectRingEntry(i)}
            >
              <time>{formatTime(event.at)}</time>
              <span class="kind">{event.kind}</span>
              <span class="severity">{event.severity}</span>
              <span class="summary">{ringSummary(event)}</span>
            </button>
          </li>
        {:else}
          <li class="empty">No events yet.</li>
        {/each}
      </ul>
    </section>

    <section class="pane" aria-label="Stream (server log relay)">
      <header>
        <h2>Stream</h2>
        <span class="status status-{devLogStream.status}">{streamStatusLabel}</span>
        <span class="count">{devLogStream.entries.length} lines</span>
      </header>
      <ul class="rows">
        {#each devLogStream.entries as entry, i (entry.emittedAt + ":" + String(i))}
          <li>
            <button
              type="button"
              class="row level-{entry.level}"
              class:selected={isStreamSelected(i)}
              onclick={() => selectStreamEntry(i)}
            >
              <time>{formatTime(entry.emittedAt)}</time>
              <span class="level">{entry.level}</span>
              <span class="summary">{streamPreview(entry)}</span>
            </button>
          </li>
        {:else}
          <li class="empty">No log lines yet — make a request.</li>
        {/each}
      </ul>
    </section>

    <section class="pane state-pane" aria-label="State (live projection)">
      <header>
        <h2>State</h2>
        <button
          type="button"
          class="show-state"
          class:selected={isStateSelected}
          onclick={selectShopState}
        >
          Show full state
        </button>
      </header>
      <div class="state-summary">
        {#if shopStateStore.value === null}
          <em>No projection yet — waiting for WS snapshot.</em>
        {:else}
          <pre>{JSON.stringify(shopStateStore.value, null, 2).slice(0, 800)}{
              JSON.stringify(shopStateStore.value, null, 2).length > 800 ? "\n…" : ""
            }</pre>
        {/if}
      </div>
    </section>

    <section class="pane detail-pane" aria-label="Detail">
      <header>
        <h2>Detail</h2>
        <span class="selection">{selectionLabel}</span>
      </header>
      <div class="detail-body">
        {#if detail === null}
          <em>Select an entry from any pane.</em>
        {:else}
          <pre>{JSON.stringify(detail, null, 2)}</pre>
        {/if}
      </div>
    </section>
  </div>
</div>

<style>
  .inspect {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: var(--space-3);
    gap: var(--space-3);
  }
  .inspect-head h1 {
    margin: 0;
    font-size: 1.25rem;
  }
  .inspect-head .hint {
    margin: 0.25rem 0 0;
    color: var(--fg-muted, #666);
    font-size: 0.85rem;
  }
  .inspect-head code {
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
    background: var(--bg-muted, #f4f4f4);
    padding: 0 0.25em;
    border-radius: 0.2em;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    grid-template-rows: 1fr 1fr;
    gap: var(--space-3);
    flex: 1;
    min-height: 0;
  }
  @media (max-width: 64rem) {
    .grid {
      grid-template-columns: 1fr;
      grid-template-rows: repeat(4, minmax(14rem, 24rem));
    }
  }
  .pane {
    display: flex;
    flex-direction: column;
    background: var(--bg, #fff);
    border: 1px solid var(--border, #e5e5e5);
    border-radius: 0.5rem;
    min-height: 0;
    overflow: hidden;
  }
  .pane > header {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border, #e5e5e5);
    background: var(--bg-muted, #fafafa);
  }
  .pane h2 {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 600;
  }
  .pane .count {
    margin-left: auto;
    color: var(--fg-muted, #777);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }
  .status {
    font-size: 0.75rem;
    padding: 0.1rem 0.5rem;
    border-radius: 0.75rem;
    margin-left: auto;
    font-weight: 500;
  }
  .status-connecting {
    background: #fff4c2;
    color: #876200;
  }
  .status-open {
    background: #d8f5d4;
    color: #1d5e16;
  }
  .status-closed {
    background: #fde0e0;
    color: #8a1d1d;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
  }
  .rows .empty {
    color: var(--fg-muted, #888);
    padding: 0.75rem;
    font-style: italic;
  }
  .row {
    display: grid;
    grid-template-columns: auto auto auto 1fr;
    gap: 0.5rem;
    align-items: baseline;
    width: 100%;
    padding: 0.3rem 0.75rem;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--border-faint, #f0f0f0);
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 0.78rem;
    color: inherit;
  }
  .row:hover {
    background: var(--bg-muted, #f7f7f7);
  }
  .row.selected {
    background: #e5f0ff;
  }
  .row time {
    color: var(--fg-muted, #888);
    font-variant-numeric: tabular-nums;
    font-family: ui-monospace, monospace;
  }
  .row .kind,
  .row .level {
    font-weight: 600;
  }
  .row .severity {
    font-size: 0.7rem;
    padding: 0 0.4em;
    border-radius: 0.25em;
    text-transform: uppercase;
  }
  .severity-error .severity {
    background: #fbe0e0;
    color: #8a1d1d;
  }
  .severity-warning .severity {
    background: #fff0d2;
    color: #8a5a00;
  }
  .severity-info .severity {
    background: #e5f0ff;
    color: #1b4d8a;
  }
  .severity-debug .severity {
    background: #ececec;
    color: #555;
  }
  .level-error {
    color: #8a1d1d;
  }
  .level-warn {
    color: #8a5a00;
  }
  .row .summary {
    font-family: ui-monospace, monospace;
    color: #333;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state-pane .state-summary,
  .detail-pane .detail-body {
    overflow: auto;
    padding: 0.75rem;
    flex: 1;
    min-height: 0;
  }
  .state-pane pre,
  .detail-pane pre {
    margin: 0;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .show-state {
    margin-left: auto;
    padding: 0.2rem 0.6rem;
    font-size: 0.75rem;
    border: 1px solid var(--border, #ccc);
    border-radius: 0.3em;
    background: var(--bg, #fff);
    cursor: pointer;
  }
  .show-state:hover {
    background: var(--bg-muted, #f4f4f4);
  }
  .show-state.selected {
    background: #e5f0ff;
    border-color: #5a85c4;
  }
  .selection {
    margin-left: auto;
    color: var(--fg-muted, #777);
    font-size: 0.8rem;
    font-family: ui-monospace, monospace;
  }
</style>
