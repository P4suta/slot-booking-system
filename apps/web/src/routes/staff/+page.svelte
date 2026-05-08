<script lang="ts">
  import { onDestroy, onMount } from "svelte"
  import {
    type ApiResult,
    callNext,
    markNoShow,
    markServed,
    queueEventSource,
    shopState,
    staffCancel,
    type Ticket,
  } from "$lib/api.js"

  let token = $state(typeof window === "undefined" ? "" : (localStorage.getItem("queue.staffToken") ?? ""))
  let authenticated = $state(token.length > 0)
  let waitingCount = $state(0)
  let serving: Ticket | null = $state(null)
  let preview: ReadonlyArray<{ id: string; seq: number }> = $state([])
  let busy = $state(false)
  let error: string | null = $state(null)
  let source: EventSource | undefined

  /**
   * Re-fetch the public shop state. Tolerant: a transient network
   * error never throws — it just leaves the previous state on screen
   * and surfaces the message in `error`.
   */
  const refresh = async (): Promise<void> => {
    try {
      const r = await shopState()
      if (!r.ok) {
        error = `refresh: ${r.error._tag}`
        return
      }
      const data = r.value as unknown as {
        waitingCount: number
        serving: Ticket | null
        waitingPreview: ReadonlyArray<{ id: string; seq: number }>
      }
      waitingCount = data.waitingCount
      serving = data.serving
      preview = data.waitingPreview
    } catch (e) {
      error = `refresh: ${String(e)}`
    }
  }

  const startLiveFeed = async (): Promise<void> => {
    await refresh()
    if (source === undefined) {
      source = queueEventSource()
      source.onmessage = () => {
        void refresh()
      }
      source.onerror = () => {
        // EventSource auto-reconnects; the error event fires per
        // failed connection attempt. Surface it once so a stalled
        // backend is visible, but do not throw.
        error = "live feed: connection lost (retrying…)"
      }
    }
  }

  /**
   * Run an action against the worker. Guarantees `busy` is released
   * even on fetch reject; surfaces the error tag/code in `error` so
   * stalls are debuggable from the UI alone.
   *
   * Generic-free signature on purpose: Svelte's TS preprocessor was
   * treating `<A>` as JSX-like and silently dropping the argument
   * list, surfacing as `ReferenceError: label is not defined` at
   * runtime. `ApiResult<unknown>` is sufficient — runAction never
   * touches the success `value`, only `ok` / `error`.
   */
  const runAction = async (
    label: string,
    fn: () => Promise<ApiResult<unknown>>,
  ): Promise<void> => {
    busy = true
    error = null
    try {
      const r = await fn()
      if (!r.ok) {
        error = `${label}: ${r.error._tag} (${r.error.code})`
        if (r.error._tag === "MissingStaffCapability") {
          onLogout()
          return
        }
      }
    } catch (e) {
      error = `${label}: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      busy = false
    }
    // Refresh after every action — successful or not — so the queue
    // counters reflect any concurrent change. Failures inside refresh
    // are themselves swallowed by the helper.
    void refresh()
  }

  const onLogin = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (token.length === 0) return
    localStorage.setItem("queue.staffToken", token)
    authenticated = true
    // onMount only runs on component mount; arriving here means the
    // user just typed the token, so kick off the live feed manually.
    await startLiveFeed()
  }

  const onLogout = (): void => {
    localStorage.removeItem("queue.staffToken")
    token = ""
    authenticated = false
    source?.close()
    source = undefined
    waitingCount = 0
    serving = null
    preview = []
    error = null
  }

  const onCallNext = (): Promise<void> =>
    runAction("call-next", () => callNext(token))

  const onMarkServed = (): Promise<void> => {
    const target = serving
    if (target === null) return Promise.resolve()
    return runAction("mark-served", () => markServed(token, target.id))
  }

  const onMarkNoShow = (): Promise<void> => {
    const target = serving
    if (target === null) return Promise.resolve()
    return runAction("mark-no-show", () => markNoShow(token, target.id))
  }

  const onCancel = (id: string): Promise<void> =>
    runAction("cancel", () => staffCancel(token, id, "staff cancel"))

  onMount(async () => {
    // Token restored from localStorage → `authenticated = true` at
    // construction → start the live feed. Otherwise wait until the
    // login form fires `onLogin`.
    if (authenticated) await startLiveFeed()
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
    cursor: not-allowed;
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
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.85rem;
    word-break: break-word;
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
