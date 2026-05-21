<script lang="ts">
  import { onDestroy, onMount } from "svelte"
  import {
    type ApiResult,
    callBatch,
    callNext,
    callSpecific,
    connectQueueFeed,
    type Lane,
    markNoShow,
    markServed,
    type QueueFeedHandle,
    type QueueFeedState,
    recall,
    reorder,
    staffCancel,
    staffShopState,
    type Ticket,
  } from "$lib/api.js"
  import Button from "$lib/components/Button.svelte"
  import Card from "$lib/components/Card.svelte"
  import Dialog from "$lib/components/Dialog.svelte"
  import Toast from "$lib/components/Toast.svelte"
  import { emptyState } from "$lib/messages.js"

  type LaneFilter = "all" | Lane

  /* ---------- state ---------- */
  let token = $state(
    typeof window === "undefined" ? "" : (localStorage.getItem("queue.staffToken") ?? ""),
  )
  let authenticated = $state(token.length > 0)
  let waitingCount = $state(0)
  let waiting: ReadonlyArray<Ticket> = $state([])
  let calling: ReadonlyArray<Ticket> = $state([])
  let overdueList: ReadonlyArray<Ticket> = $state([])
  let done: Ticket[] = $state([])
  let busy = $state(false)
  let error: string | null = $state(null)
  let feedState: QueueFeedState = $state("connecting")
  let feed: QueueFeedHandle | undefined
  let prevWaitingCount: number | null = null
  let laneFilter: LaneFilter = $state("all")
  let search = $state("")
  let batchN = $state(1)
  let selected: Set<string> = $state(new Set())
  let detail: Ticket | null = $state(null)
  let toast: { message: string; variant?: "info" | "success" | "warning" | "danger"; undoLabel?: string; onUndo?: () => void } | null = $state(null)
  let audioCue = $state(
    typeof window === "undefined" ? false : localStorage.getItem("queue.audioCue") === "1",
  )
  let now = $state(Date.now())
  let slotChipTick: ReturnType<typeof setInterval> | undefined

  // ADR-0067 grace window — same threshold the EDF lane-chain promotes
  // a reservation. The chip turns "due" within the same 5min window the
  // backend uses, so the operator sees the same boundary the projection
  // is computing.
  const SLOT_CHIP_DUE_MS = 5 * 60 * 1000

  const slotChipState = (appointmentAt: string): "due" | "overdue" | "soon" | "future" => {
    const ms = Date.parse(appointmentAt)
    const delta = ms - now
    if (delta <= -SLOT_CHIP_DUE_MS) return "overdue"
    if (delta <= SLOT_CHIP_DUE_MS) return "due"
    if (delta <= 30 * 60 * 1000) return "soon"
    return "future"
  }

  /* ---------- derived ---------- */
  const filteredWaiting = $derived.by(() => {
    let list = waiting
    if (laneFilter !== "all") list = list.filter((t) => t.lane === laneFilter)
    const q = search.trim().toLowerCase()
    if (q.length > 0) {
      list = list.filter(
        (t) =>
          (t.nameKana ?? "").toLowerCase().includes(q) ||
          (t.phoneLast4 ?? "") === q,
      )
    }
    return list
  })
  const selectionCount = $derived(selected.size)

  /* ---------- refresh ---------- */
  const refresh = async (): Promise<void> => {
    try {
      const r = await staffShopState(token)
      if (!r.ok) {
        error = `refresh: ${r.error._tag}`
        if (r.error._tag === "MissingStaffCapability") onLogout()
        return
      }
      const nextCount = r.value.waitingCount
      if (prevWaitingCount !== null && nextCount > prevWaitingCount) {
        notifyArrival(nextCount - prevWaitingCount)
      }
      prevWaitingCount = nextCount
      waitingCount = nextCount
      waiting = r.value.waitingPreview
      calling = r.value.calling
      overdueList = r.value.overdue
      done = r.value.terminal
      error = null
    } catch (e) {
      error = `refresh: ${String(e)}`
    }
  }

  /* ---------- desktop / audio cue ---------- */
  const notifyArrival = (delta: number): void => {
    const body = delta === 1 ? "新しい順番待ちが追加されました" : `${delta}件の新規順番待ち`
    if (audioCue && typeof window !== "undefined") {
      try {
        const ctx = new AudioContext()
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.connect(g)
        g.connect(ctx.destination)
        o.frequency.value = 880
        g.gain.value = 0.05
        o.start()
        setTimeout(() => {
          o.stop()
          void ctx.close()
        }, 120)
      } catch {
        // AudioContext 不可 (insecure context, autoplay policy) — silent
      }
    }
    if (typeof Notification === "undefined") return
    if (Notification.permission !== "granted") return
    if (typeof document !== "undefined" && !document.hidden) return
    try {
      new Notification("店舗管理", { body, tag: "queue-new-arrival" })
    } catch {
      // mobile Safari: outside ServiceWorker context — silent
    }
  }

  const ensureNotificationPermission = (): void => {
    if (typeof Notification === "undefined") return
    if (Notification.permission !== "default") return
    void Notification.requestPermission()
  }

  /* ---------- live feed ---------- */
  const startLiveFeed = async (): Promise<void> => {
    await refresh()
    if (feed === undefined) {
      feed = connectQueueFeed({
        onProjection: () => {
          // PII-bearing snapshot lives behind the staff token, so we
          // re-fetch over REST after every WS push.
          void refresh()
        },
        onState: (next) => {
          feedState = next
        },
      })
    }
  }

  /* ---------- generic action runner ---------- */
  async function runAction<A>(
    label: string,
    fn: () => Promise<ApiResult<A>>,
    onSuccess?: (value: A) => void,
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
        showToast(`${label} 失敗 (${r.error._tag})`, "danger")
        return
      }
      onSuccess?.(r.value)
    } catch (e) {
      error = `${label}: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      busy = false
    }
    void refresh()
  }

  const showToast = (message: string, variant?: "info" | "success" | "warning" | "danger", undoLabel?: string, onUndo?: () => void) => {
    toast = { message, variant, undoLabel, onUndo }
  }

  /* ---------- auth ---------- */
  const onLogin = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (token.length === 0) return
    localStorage.setItem("queue.staffToken", token)
    authenticated = true
    ensureNotificationPermission()
    await startLiveFeed()
  }

  const onLogout = (): void => {
    localStorage.removeItem("queue.staffToken")
    token = ""
    authenticated = false
    feed?.close()
    feed = undefined
    waitingCount = 0
    waiting = []
    calling = []
    overdueList = []
    done = []
    selected = new Set()
    prevWaitingCount = null
    error = null
  }

  /* ---------- operator actions ---------- */
  const onCallNext = (lane?: Lane) =>
    runAction(
      "call-next",
      () => callNext(token, lane !== undefined ? { lane } : {}),
      (v) => {
        const t = (v as { ticket: Ticket }).ticket
        showToast(`#${t.displaySeq} を呼び出しました`, "info", "取消", () => onRecallTicket(t.id))
      },
    )

  const onCallSpecific = (ticketId: string) =>
    runAction(
      "call-specific",
      () => callSpecific(token, ticketId),
      (v) => {
        const t = (v as { ticket: Ticket }).ticket
        showToast(`#${t.displaySeq} を呼び出しました`, "info", "取消", () => onRecallTicket(t.id))
      },
    )

  const onCallBatch = () => {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    void runAction(
      "call-batch",
      () => callBatch(token, ids),
      () => {
        showToast(`${ids.length} 件をまとめて呼び出しました`, "info")
        selected = new Set()
      },
    )
  }

  const onCallNextBatch = () => {
    const ids = filteredWaiting.slice(0, batchN).map((t) => t.id)
    if (ids.length === 0) return
    void runAction(
      "call-next-batch",
      () => callBatch(token, ids),
      () => showToast(`${ids.length} 件を順次呼び出しました`, "info"),
    )
  }

  const onMarkServed = (ticketId: string) =>
    runAction("mark-served", () => markServed(token, ticketId), () => showToast("対応完了", "success"))

  const onMarkNoShow = (ticketId: string) =>
    runAction("mark-no-show", () => markNoShow(token, ticketId), () => showToast("不在 (NoShow) に記録", "warning"))

  const onRecallTicket = (ticketId: string) =>
    runAction("recall", () => recall(token, ticketId), () => showToast("取り消しました", "info"))

  const onStaffCancel = (ticketId: string) =>
    runAction("cancel", () => staffCancel(token, ticketId, "staff-cancel"), () => showToast("キャンセル", "warning"))

  const onReorderToHead = (ticketId: string) =>
    runAction("reorder", () => reorder(token, { ticketId, afterTicketId: null }), () => showToast("先頭に移動", "info"))

  /* ---------- selection ---------- */
  const toggleSelect = (id: string, event?: MouseEvent) => {
    const next = new Set(selected)
    if (event?.shiftKey === true) {
      if (next.has(id)) next.delete(id)
      else next.add(id)
    } else {
      next.clear()
      next.add(id)
    }
    selected = next
  }

  const onAudioToggle = () => {
    audioCue = !audioCue
    localStorage.setItem("queue.audioCue", audioCue ? "1" : "0")
  }

  /* ---------- lifecycle ---------- */
  onMount(async () => {
    if (authenticated) {
      ensureNotificationPermission()
      await startLiveFeed()
    }
    // 1Hz tick drives the slot chip due/overdue colour transition.
    slotChipTick = setInterval(() => {
      now = Date.now()
    }, 1000)
  })

  onDestroy(() => {
    feed?.close()
    if (slotChipTick !== undefined) clearInterval(slotChipTick)
  })
</script>

<svelte:head>
  <title>店舗管理 — 整理券</title>
  <meta name="robots" content="noindex" />
</svelte:head>

{#if !authenticated}
  <section class="login">
    <Card>
      <h1>担当者ログイン</h1>
      <form onsubmit={onLogin}>
        <label class="field">
          <span class="label">担当者トークン</span>
          <input type="password" bind:value={token} required autocomplete="off" />
        </label>
        <Button type="submit" size="lg" fullWidth>ログイン</Button>
      </form>
    </Card>
  </section>
{:else}
  <div class="staff">
    <!-- top bar -->
    <header class="topbar">
      <div class="lane-chips" role="tablist" aria-label="lane filter">
        {#each ["all", "walkIn", "priority", "reservation"] as filter}
          <button
            type="button"
            role="tab"
            class="chip"
            data-active={laneFilter === filter ? "true" : undefined}
            onclick={() => (laneFilter = filter as LaneFilter)}
          >
            {filter === "all" ? "全部" : filter === "priority" ? "優先" : filter === "reservation" ? "予約" : "通常"}
          </button>
        {/each}
      </div>
      <input
        type="search"
        bind:value={search}
        placeholder="名前 (一部) / 末尾4桁"
        class="search"
      />
      <div class="batch">
        <input type="number" bind:value={batchN} min="1" max="20" />
        <Button variant="secondary" size="md" onclick={onCallNextBatch}>{batchN} 人呼ぶ</Button>
      </div>
      <div class="meta">
        <span class="dot" data-state={feedState} aria-label={`feed: ${feedState}`}></span>
        <Button variant="ghost" size="md" onclick={onAudioToggle} aria-label="audio cue">
          {audioCue ? "🔔" : "🔕"}
        </Button>
        <Button variant="ghost" size="md" onclick={onLogout}>ログアウト</Button>
      </div>
    </header>

    {#if error !== null}
      <p class="error" role="alert">{error}</p>
    {/if}

    <!-- 4-column kanban -->
    <div class="kanban">
      <section class="col">
        <header><h2>待機 ({filteredWaiting.length} / {waitingCount})</h2></header>
        <div class="cards">
          {#each filteredWaiting as t (t.id)}
            <Card interactive>
              <div
                class="ticket"
                role="button"
                tabindex="0"
                aria-pressed={selected.has(t.id)}
                data-selected={selected.has(t.id) ? "true" : undefined}
                onclick={(e) => toggleSelect(t.id, e)}
                onkeydown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    detail = t
                  }
                }}
                ondblclick={() => (detail = t)}
              >
                <div class="ticket-head">
                  <span class="numeral">{t.displaySeq}</span>
                  <span class="lane lane-{t.lane}">{t.lane === "priority" ? "優先" : t.lane === "reservation" ? "予約" : "通常"}</span>
                  {#if t.appointmentAt !== null}
                    <span class="slot-chip" data-time-state={slotChipState(t.appointmentAt)}>
                      {t.appointmentAt.slice(11, 16)}
                    </span>
                  {/if}
                </div>
                <div class="ticket-body">
                  <span class="kana">{t.nameKana ?? ""}</span>
                  <span class="last4">{t.phoneLast4 ?? ""}</span>
                </div>
              </div>
            </Card>
          {/each}
          {#if filteredWaiting.length === 0}
            <p class="empty">{emptyState("waiting")}</p>
          {/if}
        </div>
      </section>

      <section class="col">
        <header><h2>呼び出し中 ({calling.length})</h2></header>
        <div class="cards">
          {#each calling as t (t.id)}
            <Card>
              <div class="ticket" role="group" aria-label="called ticket">
                <div class="ticket-head">
                  <span class="numeral">{t.displaySeq}</span>
                  <span class="lane lane-{t.lane}">{t.lane === "priority" ? "優先" : t.lane === "reservation" ? "予約" : "通常"}</span>
                  {#if t.appointmentAt !== null}
                    <span class="slot-chip" data-time-state={slotChipState(t.appointmentAt)}>
                      {t.appointmentAt.slice(11, 16)}
                    </span>
                  {/if}
                </div>
                <div class="ticket-body">
                  <span class="kana">{t.nameKana ?? ""}</span>
                  <span class="last4">{t.phoneLast4 ?? ""}</span>
                </div>
                <div class="row">
                  <Button variant="primary" size="md" onclick={() => onMarkServed(t.id)} disabled={busy}>完了</Button>
                  <Button variant="ghost" size="md" onclick={() => onMarkNoShow(t.id)} disabled={busy}>不在</Button>
                  <Button variant="ghost" size="md" onclick={() => onRecallTicket(t.id)} disabled={busy}>取消</Button>
                  <Button variant="ghost" size="md" onclick={() => onStaffCancel(t.id)} disabled={busy}>キャンセル</Button>
                </div>
              </div>
            </Card>
          {/each}
          {#if calling.length === 0}
            <p class="empty">{emptyState("calling")}</p>
          {/if}
        </div>
      </section>

      <section class="col">
        <header><h2>応答待ち ({overdueList.length})</h2></header>
        <div class="cards">
          {#each overdueList as t (t.id)}
            <Card>
              <div class="ticket overdue" role="group" aria-label="overdue ticket">
                <div class="ticket-head">
                  <span class="numeral">{t.displaySeq}</span>
                  <span class="lane lane-{t.lane}">{t.lane === "priority" ? "優先" : t.lane === "reservation" ? "予約" : "通常"}</span>
                  {#if t.nudgeCount !== undefined && t.nudgeCount > 0}
                    <span class="nudge-badge" aria-label="nudge count">{t.nudgeCount}回催促</span>
                  {/if}
                  {#if t.appointmentAt !== null}
                    <span class="slot-chip" data-time-state={slotChipState(t.appointmentAt)}>
                      {t.appointmentAt.slice(11, 16)}
                    </span>
                  {/if}
                </div>
                <div class="ticket-body">
                  <span class="kana">{t.nameKana ?? ""}</span>
                  <span class="last4">{t.phoneLast4 ?? ""}</span>
                </div>
                <div class="row">
                  <Button variant="primary" size="md" onclick={() => onMarkServed(t.id)} disabled={busy}>完了</Button>
                  <Button variant="ghost" size="md" onclick={() => onMarkNoShow(t.id)} disabled={busy}>不在</Button>
                  <Button variant="ghost" size="md" onclick={() => onRecallTicket(t.id)} disabled={busy}>取消</Button>
                  <Button variant="ghost" size="md" onclick={() => onStaffCancel(t.id)} disabled={busy}>キャンセル</Button>
                </div>
              </div>
            </Card>
          {/each}
          {#if overdueList.length === 0}
            <p class="empty">{emptyState("overdue")}</p>
          {/if}
        </div>
      </section>

      <section class="col">
        <header><h2>履歴</h2></header>
        <div class="cards">
          {#each done.slice(0, 8) as t (t.id)}
            <Card>
              <div class="ticket muted">
                <div class="ticket-head">
                  <span class="numeral">{t.displaySeq}</span>
                  <span class="lane">{t.state}</span>
                </div>
              </div>
            </Card>
          {/each}
          {#if done.length === 0}
            <p class="empty">{emptyState("terminal")}</p>
          {/if}
        </div>
      </section>
    </div>

    <!-- bottom action bar -->
    {#if selectionCount > 0}
      <footer class="action-bar">
        <span>{selectionCount} 件選択</span>
        <Button variant="primary" onclick={onCallBatch} disabled={busy}>{selectionCount} 件呼ぶ</Button>
        <Button variant="ghost" onclick={() => (selected = new Set())}>選択解除</Button>
      </footer>
    {/if}

    <!-- detail drawer (Dialog) -->
    <Dialog
      bind:open={() => detail !== null, (v) => { if (!v) detail = null }}
      title={detail !== null ? `#${detail.displaySeq} 詳細` : ""}
      onClose={() => (detail = null)}
    >
      {#if detail !== null}
        <dl class="detail">
          <dt>state</dt><dd>{detail.state}</dd>
          <dt>lane</dt><dd>{detail.lane}</dd>
          <dt>seq</dt><dd>{detail.seq}</dd>
          <dt>displaySeq</dt><dd>{detail.displaySeq}</dd>
          <dt>name</dt><dd>{detail.nameKana ?? ""}</dd>
          <dt>last4</dt><dd>{detail.phoneLast4 ?? ""}</dd>
          {#if detail.freeText !== null && detail.freeText !== undefined}
            <dt>用件</dt><dd>{detail.freeText}</dd>
          {/if}
        </dl>
      {/if}
      {#snippet actions()}
        {#if detail !== null}
          {#if detail.state === "Waiting"}
            <Button variant="primary" onclick={() => detail !== null && onCallSpecific(detail.id)}>個別呼び出し</Button>
            <Button variant="secondary" onclick={() => detail !== null && onReorderToHead(detail.id)}>先頭に移動</Button>
          {/if}
          <Button variant="ghost" onclick={() => (detail = null)}>閉じる</Button>
        {/if}
      {/snippet}
    </Dialog>

    <!-- help dialog -->
    <!-- toast -->
    {#if toast !== null}
      <div class="toast-host">
        <Toast
          message={toast.message}
          variant={toast.variant}
          undoLabel={toast.undoLabel}
          onUndo={toast.onUndo}
          onDismiss={() => (toast = null)}
        />
      </div>
    {/if}
  </div>
{/if}

<style>
  .login {
    max-width: 24rem;
    margin: var(--space-12) auto;
    padding: 0 var(--space-4);
  }
  .login h1 {
    font: var(--text-numeral-md);
    margin: 0 0 var(--space-4);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }
  .label {
    font: var(--text-label-md);
    color: var(--color-fg-secondary);
  }
  input {
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
  }
  .staff {
    padding: var(--space-4);
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .lane-chips {
    display: flex;
    gap: var(--space-2);
  }
  .chip {
    background: transparent;
    color: var(--color-fg-secondary);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-pill);
    padding: var(--space-2) var(--space-4);
    font: var(--text-label-sm);
  }
  .chip[data-active="true"] {
    background: var(--color-fg-primary);
    color: var(--color-bg-surface);
    border-color: transparent;
  }
  .search {
    flex: 1;
    min-width: 12rem;
  }
  .batch {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }
  .batch input {
    width: 4rem;
    padding: var(--space-2);
  }
  .meta {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin-left: auto;
  }
  .dot {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: var(--radius-pill);
    background: var(--color-fg-muted);
  }
  .dot[data-state="open"] {
    background: var(--color-state-serving);
  }
  .dot[data-state="reconnecting"] {
    background: var(--color-state-called);
  }
  .dot[data-state="closed"] {
    background: var(--color-state-danger);
  }
  .error {
    background: oklch(95% 0.05 25);
    color: var(--color-state-danger);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    margin: 0 0 var(--space-4);
    font: var(--text-body-sm);
  }
  .kanban {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-4);
  }
  @container (min-width: 56rem) {
    .kanban {
      grid-template-columns: 1.5fr 1fr 1fr 1fr;
    }
  }
  @media (min-width: 56rem) {
    .kanban {
      grid-template-columns: 1.5fr 1fr 1fr 1fr;
    }
  }
  .col header {
    margin-bottom: var(--space-3);
  }
  .col h2 {
    font: var(--text-label-md);
    margin: 0;
    color: var(--color-fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .ticket {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .ticket[data-selected="true"] {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
    border-radius: var(--radius-md);
  }
  .ticket-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .numeral {
    font: var(--text-numeral-md);
    font-variant-numeric: tabular-nums;
    color: var(--color-fg-primary);
  }
  .lane {
    font: var(--text-label-sm);
    color: var(--color-fg-muted);
    background: var(--color-bg-subtle);
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
  }
  .lane.lane-priority {
    color: var(--color-state-called);
    background: oklch(95% 0.05 65 / 30%);
  }
  .slot-chip {
    font: var(--text-mono-sm);
    color: var(--color-fg-secondary);
    background: var(--color-bg-subtle);
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
  }
  .nudge-badge {
    font: var(--text-label-sm);
    color: oklch(35% 0.22 25);
    background: oklch(92% 0.13 30 / 60%);
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
    font-weight: 600;
  }
  .ticket.overdue {
    border-left: 3px solid oklch(70% 0.18 30);
    padding-left: var(--space-2);
  }
  .slot-chip[data-time-state="soon"] {
    color: oklch(40% 0.13 65);
    background: oklch(95% 0.07 65 / 50%);
  }
  .slot-chip[data-time-state="due"] {
    color: oklch(35% 0.18 30);
    background: oklch(92% 0.13 30 / 60%);
    font-weight: 600;
  }
  .slot-chip[data-time-state="overdue"] {
    color: oklch(35% 0.22 25);
    background: oklch(85% 0.18 25 / 70%);
    font-weight: 700;
  }
  .ticket-body {
    display: flex;
    justify-content: space-between;
    font: var(--text-body-sm);
    color: var(--color-fg-secondary);
  }
  .last4 {
    font: var(--text-mono-sm);
    color: var(--color-fg-muted);
  }
  .row {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .empty {
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
    text-align: center;
    padding: var(--space-4);
  }
  .muted {
    opacity: 0.55;
  }
  .action-bar {
    position: fixed;
    bottom: var(--space-4);
    left: 50%;
    transform: translateX(-50%);
    background: var(--color-bg-raised);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-pill);
    box-shadow: var(--shadow-lg);
    padding: var(--space-3) var(--space-5);
    display: flex;
    gap: var(--space-3);
    align-items: center;
    z-index: 100;
  }
  .detail,
  .help {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-2) var(--space-4);
    margin: 0;
  }
  .detail dt,
  .help dt {
    font: var(--text-label-md);
    color: var(--color-fg-secondary);
  }
  .detail dd,
  .help dd {
    margin: 0;
    color: var(--color-fg-primary);
  }
  .toast-host {
    position: fixed;
    bottom: var(--space-6);
    right: var(--space-6);
    z-index: 1000;
  }
</style>
