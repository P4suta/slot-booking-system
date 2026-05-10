<script lang="ts">
  import { goto } from "$app/navigation"
  import { onDestroy, onMount } from "svelte"
  import Card from "$lib/components/Card.svelte"
  import {
    connectQueueFeed,
    type LaneCounts,
    type QueueFeedHandle,
    type QueueFeedState,
    type ShopState,
    shopState,
  } from "$lib/api.js"
  import { loadingState } from "$lib/messages.js"
  import { hasStaffToken, readTicketCache } from "$lib/ticketCache.js"

  let waitingCount = $state(0)
  let laneCounts: LaneCounts = $state({ walkIn: 0, priority: 0, reservation: 0 })
  let calling = $state(0)
  let feedState: QueueFeedState = $state("connecting")
  let feed: QueueFeedHandle | undefined
  // ADR-0069 §Stage 8 — if the customer already has an active ticket
  // cached locally, every customer-facing route funnels into /ticket
  // so the customer's "where am I" never has more than one answer.
  // booting==true suppresses the landing render during the redirect
  // frame so the customer does not see the landing flash.
  let booting = $state(true)

  const refresh = (data: ShopState) => {
    waitingCount = data.waitingCount
    laneCounts = data.laneCounts
    calling = data.calling.length + data.serving.length
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
      },
    })
  })

  onDestroy(() => feed?.close())
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

    <div class="status">
      <Card>
        <div class="status-grid">
          <div class="metric">
            <span class="metric-label">待ち人数</span>
            <span class="metric-value">{waitingCount}</span>
          </div>
          <div class="metric">
            <span class="metric-label">対応中</span>
            <span class="metric-value">{calling}</span>
          </div>
        </div>
        {#if waitingCount > 0}
          <div class="lanes">
            {#if laneCounts.priority > 0}
              <span class="lane-chip priority">優先 {laneCounts.priority}</span>
            {/if}
            <span class="lane-chip">通常 {laneCounts.walkIn}</span>
            {#if laneCounts.reservation > 0}
              <span class="lane-chip">予約 {laneCounts.reservation}</span>
            {/if}
          </div>
        {/if}
      </Card>
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
  .status {
    margin: 0 0 var(--space-8);
  }
  .status-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-6);
  }
  .metric {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .metric-label {
    font: var(--text-label-sm);
    color: var(--color-fg-muted);
  }
  .metric-value {
    font: var(--text-numeral-md);
    color: var(--color-fg-primary);
    font-variant-numeric: tabular-nums;
  }
  .lanes {
    display: flex;
    gap: var(--space-2);
    justify-content: center;
    margin-top: var(--space-4);
    flex-wrap: wrap;
  }
  .lane-chip {
    font: var(--text-label-sm);
    color: var(--color-fg-secondary);
    background: var(--color-bg-subtle);
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
  }
  .lane-chip.priority {
    color: var(--color-state-called);
    background: oklch(95% 0.05 65 / 30%);
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
