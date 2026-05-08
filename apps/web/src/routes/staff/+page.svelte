<script lang="ts">
  import { onDestroy, onMount } from "svelte"
  import {
    type ApiResult,
    callNext,
    markNoShow,
    markServed,
    queueEventSource,
    staffCancel,
    staffShopState,
    type Ticket,
  } from "$lib/api.js"

  let token = $state(typeof window === "undefined" ? "" : (localStorage.getItem("queue.staffToken") ?? ""))
  let authenticated = $state(token.length > 0)
  let waitingCount = $state(0)
  let serving: Ticket | null = $state(null)
  // Staff 画面は受付業務 — 各待ちチケットの kana / 末尾4 / 用件まで
  // 表示する。 公開 endpoint と違って PII 込みの shape を fetch する。
  let preview: ReadonlyArray<Ticket> = $state([])
  let busy = $state(false)
  let error: string | null = $state(null)
  let source: EventSource | undefined

  /**
   * Re-fetch the staff-side shop state. Tolerant: a transient network
   * error never throws — it just leaves the previous state on screen
   * and surfaces the message in `error`.
   */
  const refresh = async (): Promise<void> => {
    try {
      const r = await staffShopState(token)
      if (!r.ok) {
        error = `refresh: ${r.error._tag}`
        if (r.error._tag === "MissingStaffCapability") onLogout()
        return
      }
      const data = r.value as unknown as {
        waitingCount: number
        serving: Ticket | null
        waitingPreview: ReadonlyArray<Ticket>
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
        // 直後に event = backend 健在、 過去の reconnect banner を解除
        if (error?.startsWith("live feed:") === true) error = null
        void refresh()
      }
      source.onerror = () => {
        // SSE は 30 秒ごとに server 側で close し、 client が自動
        // 再接続する設計 (Workers の stream 予算対策)。
        // CONNECTING (readyState 0) は通常の再接続中なので表示しない。
        // CLOSED (readyState 2) だけが本当の停止 — surface する。
        if (source?.readyState === EventSource.CLOSED) {
          error = "live feed: closed (再読み込みで再接続)"
        }
      }
    }
  }

  /**
   * Run an action against the worker. Guarantees `busy` is released
   * even on fetch reject; surfaces the error tag/code in `error` so
   * stalls are debuggable from the UI alone.
   *
   * Written as a `function` declaration (not an arrow) on purpose:
   * Svelte's `<script lang="ts">` preprocessor parses
   * `async <A>(args) => …` as JSX and silently drops the arg list
   * (`label is not defined` at runtime). Function declarations carry
   * no parser ambiguity, so the generic survives — and we get the
   * full type-narrowed `ApiResult<A>` back.
   */
  async function runAction<A>(
    label: string,
    fn: () => Promise<ApiResult<A>>,
  ): Promise<void> {
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
          {#if serving.nameKana !== null}
            <p class="serving-name">{serving.nameKana}</p>
          {/if}
          {#if serving.phoneLast4 !== null}
            <p class="serving-meta">末尾 {serving.phoneLast4}</p>
          {/if}
          {#if serving.freeText !== null && serving.freeText !== ""}
            <p class="serving-meta">📝 {serving.freeText}</p>
          {/if}
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
          <li class="queue-row">
            <span class="seq">#{t.seq}</span>
            <div class="info">
              <p class="info-name">{t.nameKana ?? "(名前なし)"}</p>
              <p class="info-meta">
                <span class="phone">末尾 {t.phoneLast4 ?? "—"}</span>
                {#if t.freeText !== null && t.freeText !== ""}
                  <span class="free-text">— {t.freeText}</span>
                {/if}
              </p>
              <p class="info-id">{t.id.slice(-8)}</p>
            </div>
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
  .serving-name {
    margin: 0.25rem 0 0;
    font-size: 1rem;
    font-weight: 500;
    color: #1d1d1f;
  }
  .serving-meta {
    margin: 0.1rem 0 0;
    font-size: 0.85rem;
    color: #6e6e73;
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
  .queue-row {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 0.85rem 1rem;
    background: #f5f5f7;
    border-radius: 10px;
  }
  .seq {
    font-weight: 600;
    font-size: 1.05rem;
    color: #1d1d1f;
    min-width: 2.5rem;
    padding-top: 0.1rem;
  }
  .info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }
  .info-name {
    margin: 0;
    font-weight: 500;
    color: #1d1d1f;
  }
  .info-meta {
    margin: 0;
    font-size: 0.85rem;
    color: #6e6e73;
    word-break: break-word;
  }
  .phone {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  .free-text {
    color: #1d1d1f;
  }
  .info-id {
    margin: 0;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.75rem;
    color: #aeaeb2;
  }
</style>
