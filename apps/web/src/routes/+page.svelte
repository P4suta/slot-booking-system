<script lang="ts">
  import { goto } from "$app/navigation"
  import { onDestroy, onMount } from "svelte"
  import {
    connectQueueFeed,
    type QueueFeedHandle,
    type QueueFeedState,
    type ShopState,
    shopState,
  } from "$lib/api.js"
  import { loadingState } from "$lib/messages.js"
  import { hasStaffToken, readTicketCache } from "$lib/ticketCache.js"
  import { wsStatus } from "$lib/wsStatus.js"

  let waitingCount = $state(0)
  let activeCount = $state(0)
  let feedState: QueueFeedState = $state("connecting")
  let feed: QueueFeedHandle | undefined
  // ADR-0069 §Stage 8 — if the customer already has an active ticket
  // cached locally, every customer-facing route funnels into /ticket
  // so the customer's "where am I" never has more than one answer.
  // booting==true suppresses the landing render during the redirect
  // frame so the customer does not see the landing flash.
  let booting = $state(true)

  // Flip-card cycle for the two-figure summary. We show 待ち人数 and
  // 対応窓口 (= called + serving = staff currently engaged with a
  // customer) on alternating sides of a single card; flips every
  // 5s and pauses while the customer is engaging with the card.
  let summaryFlipped = $state(false)
  let summaryFocused = $state(false)
  let summaryTimer: ReturnType<typeof setInterval> | undefined
  const startSummaryTimer = (): void => {
    if (summaryTimer !== undefined) clearInterval(summaryTimer)
    summaryTimer = setInterval(() => {
      summaryFlipped = !summaryFlipped
    }, 5000)
  }
  const stopSummaryTimer = (): void => {
    if (summaryTimer !== undefined) {
      clearInterval(summaryTimer)
      summaryTimer = undefined
    }
  }
  $effect(() => {
    if (summaryFocused) {
      stopSummaryTimer()
      summaryFlipped = false
      return
    }
    startSummaryTimer()
    return stopSummaryTimer
  })
  const onSummaryClick = (): void => {
    summaryFlipped = !summaryFlipped
    if (!summaryFocused) startSummaryTimer()
  }
  const onSummaryPointerEnter = (): void => {
    summaryFocused = true
  }
  const onSummaryPointerLeave = (): void => {
    summaryFocused = false
  }

  const refresh = (data: ShopState): void => {
    waitingCount = data.waitingCount
    activeCount = data.calling.length + data.serving.length
  }

  onMount(async () => {
    // Stage 10: staff session sandbox — a logged-in operator's tab
    // never falls through to the customer landing; bounce back to
    // /staff so the dashboard stays the dominant view until logout.
    if (hasStaffToken()) {
      await goto("/staff")
      return
    }
    const cached = readTicketCache()
    if (cached !== null) {
      await goto(`/ticket?id=${encodeURIComponent(cached.ticketId)}`)
      return
    }
    booting = false
    try {
      const initial = await shopState()
      if (initial.ok) refresh(initial.value)
    } catch {
      // initial fetch failure is non-fatal — the WS feed catches up
    }
    feed = connectQueueFeed({
      onProjection: (parsed) => refresh(parsed as ShopState),
      onState: (next) => {
        feedState = next
        wsStatus.set(next)
      },
    })
  })

  onDestroy(() => {
    feed?.close()
    wsStatus.set("none")
  })
</script>

<svelte:head>
  <title>並ぶ — 整理券</title>
</svelte:head>

{#if !booting}
  <section class="hero">
    <h1>並ぶ</h1>
    <p class="lede">店の行列に番号を取って加わる。 列の進みはそのまま見える。</p>

    {#if feedState === "reconnecting"}
      <p class="banner" role="status" aria-live="polite">{loadingState("revalidate")}</p>
    {/if}

    <div class="summary-wrap" data-flipped={summaryFlipped ? "true" : undefined}>
      <button
        type="button"
        class="summary-flip"
        onclick={onSummaryClick}
        onmouseenter={onSummaryPointerEnter}
        onmouseleave={onSummaryPointerLeave}
        onfocus={onSummaryPointerEnter}
        onblur={onSummaryPointerLeave}
        onpointerdown={onSummaryPointerEnter}
        onpointerup={onSummaryPointerLeave}
        onpointercancel={onSummaryPointerLeave}
        aria-label={summaryFlipped ? "待ち人数を表示" : "対応窓口の数を表示"}
      >
        <div class="summary-face summary-face-front">
          <span class="summary-caption">待ち人数</span>
          <span class="summary-value">{waitingCount}</span>
          <span class="summary-unit">人</span>
        </div>
        <div class="summary-face summary-face-back">
          <span class="summary-caption">対応窓口</span>
          <span class="summary-value">{activeCount}</span>
          <span class="summary-unit">件</span>
        </div>
      </button>
    </div>

    <div class="actions">
      <a class="cta" href="/issue">並ぶ</a>
      <a class="link" href="/recover">自分の番号を確認</a>
    </div>
  </section>
{/if}

<style>
  .hero {
    text-align: center;
    padding: var(--space-12) var(--space-4);
    max-width: 32rem;
    margin: 0 auto;
  }
  @media (min-width: 48rem) {
    .hero {
      max-width: 40rem;
      padding: var(--space-16) var(--space-6);
    }
  }
  h1 {
    font: var(--text-numeral-xl);
    margin: 0 0 var(--space-2);
    letter-spacing: -0.02em;
  }
  .lede {
    color: var(--color-fg-muted);
    font: var(--text-body-lg);
    margin: 0 0 var(--space-8);
  }
  .summary-wrap {
    perspective: 1200px;
    margin: 0 0 var(--space-8);
  }
  .summary-flip {
    position: relative;
    width: 100%;
    min-height: 12rem;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: pointer;
    transform-style: preserve-3d;
    transition: transform 600ms cubic-bezier(0.4, 0, 0.2, 1);
    display: block;
  }
  .summary-wrap[data-flipped="true"] .summary-flip {
    transform: rotateY(180deg);
  }
  .summary-flip:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 4px;
    border-radius: var(--radius-lg);
  }
  .summary-face {
    position: absolute;
    inset: 0;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    background: var(--color-bg-raised);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    padding: var(--space-6) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    justify-content: center;
    align-items: center;
  }
  .summary-face-back {
    transform: rotateY(180deg);
  }
  .summary-caption {
    font: var(--text-label-md);
    color: var(--color-fg-muted);
    letter-spacing: 0.05em;
  }
  .summary-value {
    font: var(--text-numeral-xl);
    font-variant-numeric: tabular-nums;
    color: var(--color-fg-primary);
    line-height: 1;
  }
  .summary-unit {
    font: var(--text-body-md);
    color: var(--color-fg-secondary);
  }
  @media (min-width: 48rem) {
    .summary-flip {
      min-height: 16rem;
    }
    .summary-value {
      font-size: 8rem;
    }
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    align-items: center;
  }
  .cta {
    display: inline-block;
    background: var(--color-accent-primary);
    color: var(--color-accent-on-primary);
    text-decoration: none;
    padding: var(--space-4) var(--space-12);
    border-radius: var(--radius-pill);
    font: var(--text-body-lg);
    font-weight: 500;
  }
  .cta:hover {
    filter: brightness(1.08);
  }
  .link {
    color: var(--color-fg-secondary);
    font: var(--text-body-sm);
    text-decoration: underline;
  }
  .banner {
    background: oklch(95% 0.07 65);
    color: oklch(40% 0.13 65);
    border: 1px solid oklch(85% 0.15 65);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    margin: 0 0 var(--space-4);
  }
</style>
