<script lang="ts">
  import { goto } from "$app/navigation"
  import { onDestroy, onMount } from "svelte"
  import Card from "$lib/components/Card.svelte"
  import {
    connectQueueFeed,
    type QueueFeedHandle,
    type QueueFeedState,
    type ShopState,
    shopState,
  } from "$lib/api.js"
  import { loadingState, m } from "$lib/messages.js"
  import { hasStaffToken, readTicketCache } from "$lib/ticketCache.js"

  let waitingCount = $state(0)
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
  <title>{m.landing_title()}</title>
</svelte:head>

{#if !booting}
  <section class="hero">
    <h1>{m.landing_h1()}</h1>

    {#if feedState === "reconnecting"}
      <p class="banner" role="status" aria-live="polite">{loadingState("revalidate")}</p>
    {/if}

    <div class="status">
      <Card>
        <div class="metric">
          <span class="metric-label">{m.landing_waiting_count_label()}</span>
          <span class="metric-value">{waitingCount}</span>
        </div>
      </Card>
    </div>

    <div class="actions">
      <a class="cta" href="/issue">{m.landing_cta_issue()}</a>
      <a class="link" href="/recover">{m.landing_cta_recover()}</a>
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
  h1 {
    font: var(--text-numeral-xl);
    margin: 0 0 var(--space-8);
    letter-spacing: -0.02em;
  }
  .status {
    margin: 0 0 var(--space-8);
  }
  .metric {
    display: flex;
    flex-direction: column;
    align-items: center;
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
