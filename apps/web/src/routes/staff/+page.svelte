<script lang="ts">
  import { onDestroy, onMount } from "svelte"
  import {
    callNext,
    markNoShow,
    markServed,
    queueEventSource,
    shopState,
    staffCancel,
    type Ticket,
  } from "$lib/api.js"

  let token = $state(typeof window === "undefined" ? "" : localStorage.getItem("queue.staffToken") ?? "")
  let authenticated = $state(token.length > 0)
  let waitingCount = $state(0)
  let serving: Ticket | null = $state(null)
  let preview: ReadonlyArray<{ id: string; seq: number }> = $state([])
  let busy = $state(false)
  let error: string | null = $state(null)
  let source: EventSource | undefined

  const refresh = async () => {
    const r = await shopState()
    if (!r.ok) return
    const data = r.value as unknown as {
      waitingCount: number
      serving: Ticket | null
      waitingPreview: ReadonlyArray<{ id: string; seq: number }>
    }
    waitingCount = data.waitingCount
    serving = data.serving
    preview = data.waitingPreview
  }

  const onLogin = (event: SubmitEvent) => {
    event.preventDefault()
    if (token.length === 0) return
    localStorage.setItem("queue.staffToken", token)
    authenticated = true
  }

  const onLogout = () => {
    localStorage.removeItem("queue.staffToken")
    token = ""
    authenticated = false
  }

  const wrap = async <A>(fn: () => Promise<{ ok: boolean; error?: { _tag: string } }>) => {
    busy = true
    error = null
    const r = await fn()
    busy = false
    if (!r.ok && r.error !== undefined) {
      error = r.error._tag
      if (r.error._tag === "MissingStaffCapability") onLogout()
    }
    await refresh()
  }

  const onCallNext = () => wrap(() => callNext(token))
  const onMarkServed = () => {
    if (serving === null) return Promise.resolve()
    return wrap(() => markServed(token, serving.id))
  }
  const onMarkNoShow = () => {
    if (serving === null) return Promise.resolve()
    return wrap(() => markNoShow(token, serving.id))
  }
  const onCancel = (id: string) => wrap(() => staffCancel(token, id, "staff cancel"))

  onMount(async () => {
    if (authenticated) {
      await refresh()
      source = queueEventSource()
      source.onmessage = () => refresh()
    }
  })

  onDestroy(() => source?.close())
</script>

<section>
  {#if !authenticated}
    <h1>店舗管理</h1>
    <p class="lede">担当者トークンでログインしてください。</p>
    <form onsubmit={onLogin}>
      <label>
        <span>担当者トークン</span>
        <input type="password" bind:value={token} required autocomplete="off" />
      </label>
      <button type="submit">ログイン</button>
    </form>
  {:else}
    <header>
      <h1>店舗管理</h1>
      <button class="logout" onclick={onLogout}>ログアウト</button>
    </header>
    <div class="status">
      <div class="metric">
        <span>待ち</span>
        <strong>{waitingCount}</strong>
      </div>
      <div class="metric">
        <span>呼び出し中</span>
        {#if serving !== null}
          <strong>#{serving.seq}</strong>
          <p class="ticket-id">{serving.id}</p>
        {:else}
          <strong class="muted">—</strong>
        {/if}
      </div>
    </div>
    <div class="actions">
      <button class="primary" onclick={onCallNext} disabled={busy || waitingCount === 0}>
        次を呼ぶ
      </button>
      {#if serving !== null}
        <button onclick={onMarkServed} disabled={busy}>対応完了</button>
        <button class="warn" onclick={onMarkNoShow} disabled={busy}>不在</button>
      {/if}
    </div>
    {#if error !== null}
      <p class="error">エラー: {error}</p>
    {/if}
    <h2>待ち行列</h2>
    {#if preview.length === 0}
      <p class="empty">待ち行列は空です</p>
    {:else}
      <ul class="queue">
        {#each preview as t (t.id)}
          <li>
            <span class="seq">#{t.seq}</span>
            <code>{t.id.slice(-8)}</code>
            <button class="warn small" onclick={() => onCancel(t.id)} disabled={busy}>キャンセル</button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  section {
    max-width: 32rem;
    margin: 1rem auto;
    padding: 0 1rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h1 {
    margin: 0;
  }
  .lede {
    color: #6e6e73;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 20rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  input {
    padding: 0.7rem;
    border: 1px solid #d2d2d7;
    border-radius: 8px;
    font-size: 1rem;
  }
  button {
    padding: 0.7rem 1.2rem;
    background: #1d1d1f;
    color: white;
    border: none;
    border-radius: 999px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
  }
  button.primary {
    background: #0071e3;
  }
  button.warn {
    background: #c11;
  }
  button.small {
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
  }
  button.logout {
    background: transparent;
    color: #1d1d1f;
    border: 1px solid #d2d2d7;
    padding: 0.4rem 1rem;
    font-size: 0.85rem;
  }
  .status {
    display: flex;
    gap: 1rem;
    margin: 1.5rem 0;
  }
  .metric {
    flex: 1;
    background: #f5f5f7;
    padding: 1rem;
    border-radius: 12px;
  }
  .metric span {
    color: #86868b;
    font-size: 0.85rem;
  }
  .metric strong {
    display: block;
    font-size: 2rem;
    margin-top: 0.25rem;
  }
  .metric .muted {
    color: #d2d2d7;
  }
  .ticket-id {
    margin: 0.25rem 0 0;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
    color: #86868b;
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 1.5rem;
  }
  .error {
    background: #fff1f0;
    color: #c11;
    padding: 0.75rem;
    border-radius: 8px;
    margin: 1rem 0;
  }
  h2 {
    margin: 1.5rem 0 0.75rem;
    font-size: 1.2rem;
  }
  .empty {
    color: #86868b;
    font-style: italic;
  }
  .queue {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .queue li {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem;
    background: #f5f5f7;
    border-radius: 8px;
  }
  .seq {
    font-weight: 500;
    width: 3rem;
  }
  code {
    flex: 1;
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
    color: #86868b;
  }
</style>
