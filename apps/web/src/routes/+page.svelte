<script lang="ts">
  import { onDestroy, onMount } from "svelte"
  import {
    connectQueueFeed,
    type QueueFeedHandle,
    type QueueFeedState,
    type ShopState,
    shopState,
  } from "$lib/api.js"

  let waitingCount = $state(0)
  let serving: { id: string; seq: number } | null = $state(null)
  let feedState: QueueFeedState = $state("connecting")
  let feed: QueueFeedHandle | undefined

  const refresh = (data: ShopState) => {
    waitingCount = data.waitingCount
    serving = data.serving === null ? null : { id: data.serving.id, seq: data.serving.seq }
  }

  onMount(async () => {
    try {
      const initial = await shopState()
      if (initial.ok) refresh(initial.value)
    } catch {
      // initial fetch failure is non-fatal — the WS feed catches up
    }
    feed = connectQueueFeed({
      onProjection: (parsed) => {
        refresh(parsed as ShopState)
      },
      onState: (next) => {
        feedState = next
      },
      // onError is intentionally a no-op here; the reconnect logic
      // owns recovery, and the banner reflects the current `state`.
    })
  })

  onDestroy(() => feed?.close())
</script>

<section class="hero">
  <h1>並ぶ</h1>
  <p class="lede">店の行列に番号を取って加わる。 列の進みはそのまま見える。</p>
  {#if feedState === "reconnecting"}
    <p class="banner">再接続中…</p>
  {/if}
  <div class="status">
    <p>現在 <strong>{waitingCount}</strong> 人待ち</p>
    {#if serving !== null}
      <p>呼び出し中: <code>{serving.id.slice(-6)}</code> (#{serving.seq})</p>
    {/if}
  </div>
  <a class="cta" href="/issue">並ぶ</a>
  <p class="hint">
    既に番号をお持ちの方は <a href="/ticket">ticket panel</a> から確認できます。
  </p>
</section>

<style>
  .hero {
    text-align: center;
    padding: 4rem 1rem;
    max-width: 32rem;
    margin: 0 auto;
  }
  h1 {
    font-size: 3rem;
    margin: 0 0 0.5rem;
    letter-spacing: -0.02em;
  }
  .lede {
    color: #6e6e73;
    font-size: 1.05rem;
    margin: 0 0 2rem;
  }
  .status {
    background: #f5f5f7;
    border-radius: 16px;
    padding: 1.5rem;
    margin: 0 0 2rem;
  }
  .status p {
    margin: 0.25rem 0;
  }
  .status strong {
    font-size: 2rem;
    color: #1d1d1f;
  }
  .cta {
    display: inline-block;
    background: #1d1d1f;
    color: white;
    text-decoration: none;
    padding: 1rem 2.5rem;
    border-radius: 999px;
    font-size: 1.1rem;
    font-weight: 500;
  }
  .cta:hover {
    background: #333;
  }
  .banner {
    background: #fff4d6;
    border: 1px solid #f0c040;
    color: #8a5a00;
    border-radius: 12px;
    padding: 0.75rem 1rem;
    margin: 0 0 1rem;
  }
  .hint {
    margin-top: 2rem;
    color: #86868b;
    font-size: 0.9rem;
  }
  code {
    background: #f5f5f7;
    padding: 0.2rem 0.5rem;
    border-radius: 6px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
</style>
