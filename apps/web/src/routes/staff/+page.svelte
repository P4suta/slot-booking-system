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
    startServing,
    type Ticket,
  } from "$lib/api.js"
  import Button from "$lib/components/Button.svelte"
  import Card from "$lib/components/Card.svelte"
  import Dialog from "$lib/components/Dialog.svelte"
  import Help from "$lib/components/Help.svelte"
  import Toast from "$lib/components/Toast.svelte"
  import { emptyState, m } from "$lib/messages.js"
  import { clearStaffSession, markStaffLoggedIn } from "$lib/staffSession.js"
  import { wsStatus } from "$lib/wsStatus.js"

  type LaneFilter = "all" | Lane

  /* ---------- state ---------- */
  let token = $state(
    typeof window === "undefined" ? "" : (localStorage.getItem("queue.staffToken") ?? ""),
  )
  let authenticated = $state(token.length > 0)
  let waitingCount = $state(0)
  let waiting: ReadonlyArray<Ticket> = $state([])
  let calling: ReadonlyArray<Ticket> = $state([])
  let servingList: ReadonlyArray<Ticket> = $state([])
  let done: Ticket[] = $state([])
  let busy = $state(false)
  let error: string | null = $state(null)
  let feedState: QueueFeedState = $state("connecting")
  let feed: QueueFeedHandle | undefined
  let prevWaitingCount: number | null = null
  let laneFilter: LaneFilter = $state("all")
  let search = $state("")
  let selected: Set<string> = $state(new Set())
  let expanded: Set<string> = $state(new Set())
  let toast: { message: string; variant?: "info" | "success" | "warning" | "danger"; undoLabel?: string; onUndo?: () => void } | null = $state(null)
  // Batch-call confirmation dialog. The previous design was a free
  // number input + "先頭から呼ぶ" button on the topbar; a single
  // mistyped digit could call 11 customers at once. The dialog
  // restricts the choice to a preset (2 / 3 / 5) and requires an
  // explicit confirmation step.
  let batchDialogOpen = $state(false)
  let batchDialogN: number = $state(2)
  let now = $state(Date.now())
  let slotChipTick: ReturnType<typeof setInterval> | undefined

  // ADR-0067 grace window — same threshold the EDF lane-chain promotes
  // a reservation. The chip turns "due" within the same 5min window the
  // backend uses, so the operator sees the same boundary the projection
  // is computing.
  const SLOT_CHIP_DUE_MS = 5 * 60 * 1000

  // Single source for state / lane translation across all the
  // staff-side detail panels (waiting accordion + history accordion).
  // The customer-facing chips fall through paraglide already; this
  // helper covers the dl pairs where we render the value text.
  const stateLabelJa = (s: Ticket["state"]): string => {
    switch (s) {
      case "Waiting":
        return m.state_Waiting()
      case "Called":
        return m.state_Called()
      case "Serving":
        return m.state_Serving()
      case "Served":
        return m.state_Served()
      case "NoShow":
        return m.state_NoShow()
      case "Cancelled":
        return m.state_Cancelled()
    }
  }
  const laneLabelJa = (l: Lane): string => {
    switch (l) {
      case "walkIn":
        return m.lane_walkIn()
      case "priority":
        return m.lane_priority()
      case "reservation":
        return m.lane_reservation()
    }
  }

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
      servingList = r.value.serving
      done = r.value.terminal
      error = null
    } catch (e) {
      error = `refresh: ${String(e)}`
    }
  }

  /* ---------- desktop notification on new arrival ---------- */
  const notifyArrival = (delta: number): void => {
    const body = delta === 1 ? "新しい順番待ちが追加されました" : `${delta}件の新規順番待ち`
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
          wsStatus.set(next)
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
    markStaffLoggedIn()
    authenticated = true
    ensureNotificationPermission()
    await startLiveFeed()
  }

  const onLogout = (): void => {
    clearStaffSession()
    token = ""
    authenticated = false
    feed?.close()
    feed = undefined
    waitingCount = 0
    waiting = []
    calling = []
    servingList = []
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

  /**
   * The primary action surfaced on the topbar — call the single
   * next customer in line. Reuses `onCallNext` (no lane filter
   * argument, so the preferred-lane chain in ADR-0062 decides
   * which lane to pull from).
   */
  const onCallNextOne = (): Promise<void> => onCallNext()

  /**
   * Confirmed multi-customer call from the batch dialog. Pulls
   * `batchDialogN` ticket ids from the head of `filteredWaiting`
   * and fires `callBatch`. The dialog closes on success; on
   * failure the dialog stays open so the operator sees the inline
   * error before retrying.
   */
  const onCallBatchConfirm = async (): Promise<void> => {
    const ids = filteredWaiting.slice(0, batchDialogN).map((t) => t.id)
    if (ids.length === 0) {
      batchDialogOpen = false
      return
    }
    await runAction(
      "call-next-batch",
      () => callBatch(token, ids),
      () => {
        showToast(`${ids.length} 件を順次呼び出しました`, "info")
        batchDialogOpen = false
      },
    )
  }

  const onStartServing = (ticketId: string) =>
    runAction("start-serving", () => startServing(token, ticketId), () => showToast("対応中に切り替えました", "success"))

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
  // Checkbox is now the selection affordance (the card body is the
  // accordion trigger). A plain checkbox change toggles; the
  // additive shift-modifier from the dblclick era is gone, but
  // multi-select still works because each checkbox is independent.
  const toggleSelect = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selected = next
  }

  /* ---------- accordion ---------- */
  // ADR-0070 follow-up: the previous double-click → Dialog flow was
  // not discoverable for non-technical staff. Single-click on the
  // card body now expands an inline detail panel, and multiple
  // panels can be open at once (Set instead of single Ticket
  // reference). Selection moved to a dedicated checkbox in B-2 so
  // the card body click stays unambiguous.
  const toggleExpanded = (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expanded = next
  }

  /* ---------- lifecycle ---------- */
  onMount(async () => {
    if (authenticated) {
      // Token came from localStorage at script init; the shared
      // store needs to mirror it so the layout's ログアウト button
      // renders without waiting for an explicit login event.
      markStaffLoggedIn()
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

<!-- While the staff dashboard is mounted, lock the document
     scroll. The fixed-position viewport-fit `.staff` owns the
     whole area below the layout header; any scrollbar gutter the
     browser would reserve on `<html>` / `<body>` is a phantom
     strip that does not correspond to any overflowing content. -->
<svelte:head>
  <title>店舗管理 — 整理券</title>
  <meta name="robots" content="noindex" />
  {#if authenticated}
    <style>html, body { overflow: hidden; }</style>
  {/if}
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
    {#if error !== null}
      <p class="error" role="alert">{error}</p>
    {/if}

    <!-- 4-column kanban -->
    <div class="kanban">
      <section class="col">
        <header class="col-header waiting-col-header">
          <div class="col-title-row">
            <h2>待機 ({filteredWaiting.length} / {waitingCount})</h2>
            <div class="primary-action">
              <Button variant="primary" size="md" onclick={onCallNextOne} disabled={busy}>
                {m.call_next_one_button()}
              </Button>
              <button
                type="button"
                class="batch-link"
                onclick={() => (batchDialogOpen = true)}
                disabled={busy}
              >
                {m.call_next_batch_link()}
              </button>
            </div>
          </div>
          <input
            type="search"
            bind:value={search}
            placeholder="名前 (一部) / 末尾4桁で検索"
            aria-label="待機客を検索"
            class="search"
          />
          <div class="lane-filter" role="radiogroup" aria-label="待機列の種別絞り込み">
            <span class="filter-label">{m.filter_label()}</span>
            <Help
              text={m.lane_help_summary()}
              label="種別の説明を表示"
              placement="below"
              align="start"
            />
            {#each ["all", "walkIn", "priority", "reservation"] as filter}
              <button
                type="button"
                role="radio"
                class="chip"
                aria-checked={laneFilter === filter}
                data-active={laneFilter === filter ? "true" : undefined}
                onclick={() => (laneFilter = filter as LaneFilter)}
              >
                {filter === "all"
                  ? "全部"
                  : filter === "priority"
                    ? "優先"
                    : filter === "reservation"
                      ? "予約"
                      : "通常"}
              </button>
            {/each}
          </div>
        </header>
        <div class="cards">
          {#each filteredWaiting as t (t.id)}
            <Card interactive>
              <div
                class="ticket waiting-card"
                data-selected={selected.has(t.id) ? "true" : undefined}
                data-expanded={expanded.has(t.id) ? "true" : undefined}
              >
                <label class="select-handle" aria-label="呼び出し対象として選択">
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onchange={() => toggleSelect(t.id)}
                  />
                </label>
                <button
                  type="button"
                  class="ticket-body-button"
                  aria-expanded={expanded.has(t.id)}
                  aria-controls={`ticket-detail-${t.id}`}
                  onclick={() => toggleExpanded(t.id)}
                >
                  <div class="ticket-head">
                    <span class="numeral">{t.displaySeq}</span>
                    <span class="lane lane-{t.lane}">{laneLabelJa(t.lane)}</span>
                    {#if t.appointmentAt !== null}
                      <span class="slot-chip" data-state={slotChipState(t.appointmentAt)}>
                        {t.appointmentAt.slice(11, 16)}
                      </span>
                    {/if}
                  </div>
                  <div class="ticket-body">
                    <span class="kana">{t.nameKana ?? ""}</span>
                    <span class="last4">{t.phoneLast4 ?? ""}</span>
                  </div>
                </button>
                {#if expanded.has(t.id)}
                  <div id={`ticket-detail-${t.id}`} class="ticket-detail">
                    <dl>
                      <dt>状態</dt>
                      <dd>{stateLabelJa(t.state)}</dd>
                      <dt>レーン</dt>
                      <dd>{laneLabelJa(t.lane)}</dd>
                      <dt>受付番号</dt>
                      <dd>{t.displaySeq}</dd>
                      <dt>お名前</dt>
                      <dd>{t.nameKana ?? ""}</dd>
                      <dt>電話末尾</dt>
                      <dd>{t.phoneLast4 ?? ""}</dd>
                      {#if t.freeText !== null && t.freeText !== undefined}
                        <dt>ご相談内容</dt>
                        <dd class="freetext">{t.freeText}</dd>
                      {/if}
                      {#if t.appointmentAt !== null}
                        <dt>予約時刻</dt>
                        <dd>{t.appointmentAt.slice(11, 16)}</dd>
                      {/if}
                    </dl>
                    <div class="detail-actions">
                      <Button variant="primary" size="md" onclick={() => onCallSpecific(t.id)} disabled={busy}>
                        個別呼び出し
                      </Button>
                      <Button variant="secondary" size="md" onclick={() => onReorderToHead(t.id)} disabled={busy}>
                        先頭に移動
                      </Button>
                    </div>
                  </div>
                {/if}
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
              <div class="ticket" role="group" aria-label="呼び出し中の整理券">
                <div class="ticket-head">
                  <span class="numeral">{t.displaySeq}</span>
                  <span class="lane lane-{t.lane}">{laneLabelJa(t.lane)}</span>
                  {#if t.appointmentAt !== null}
                    <span class="slot-chip" data-state={slotChipState(t.appointmentAt)}>
                      {t.appointmentAt.slice(11, 16)}
                    </span>
                  {/if}
                </div>
                <div class="ticket-body">
                  <span class="kana">{t.nameKana ?? ""}</span>
                  <span class="last4">{t.phoneLast4 ?? ""}</span>
                </div>
                <div class="row">
                  <Button variant="primary" size="md" onclick={() => onStartServing(t.id)} disabled={busy}>対応開始</Button>
                  <Button variant="secondary" size="md" onclick={() => onMarkServed(t.id)} disabled={busy}>完了</Button>
                  <Button variant="ghost" size="md" onclick={() => onMarkNoShow(t.id)} disabled={busy}>不在</Button>
                  <Button variant="ghost" size="md" onclick={() => onRecallTicket(t.id)} disabled={busy}>取消</Button>
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
        <header><h2>対応中 ({servingList.length})</h2></header>
        <div class="cards">
          {#each servingList as t (t.id)}
            <Card>
              <div class="ticket" role="group" aria-label="対応中の整理券">
                <div class="ticket-head">
                  <span class="numeral">{t.displaySeq}</span>
                  <span class="lane lane-{t.lane}">{laneLabelJa(t.lane)}</span>
                  {#if t.appointmentAt !== null}
                    <span class="slot-chip" data-state={slotChipState(t.appointmentAt)}>
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
                  <Button variant="ghost" size="md" onclick={() => onStaffCancel(t.id)} disabled={busy}>キャンセル</Button>
                </div>
              </div>
            </Card>
          {/each}
          {#if servingList.length === 0}
            <p class="empty">{emptyState("serving")}</p>
          {/if}
        </div>
      </section>

      <section class="col">
        <header><h2>履歴 ({done.length})</h2></header>
        <div class="cards">
          {#each done.slice(0, 12) as t (t.id)}
            <Card interactive>
              <div
                class="ticket history-card"
                data-expanded={expanded.has(t.id) ? "true" : undefined}
              >
                <button
                  type="button"
                  class="ticket-body-button"
                  aria-expanded={expanded.has(t.id)}
                  aria-controls={`history-detail-${t.id}`}
                  onclick={() => toggleExpanded(t.id)}
                >
                  <div class="ticket-head">
                    <span class="numeral">{t.displaySeq}</span>
                    <span class="lane lane-{t.lane}">{laneLabelJa(t.lane)}</span>
                    <span class="state-badge" data-state={t.state}>{stateLabelJa(t.state)}</span>
                  </div>
                  <div class="ticket-body">
                    <span class="kana">{t.nameKana ?? ""}</span>
                    <span class="last4">{t.phoneLast4 ?? ""}</span>
                  </div>
                </button>
                {#if expanded.has(t.id)}
                  <div id={`history-detail-${t.id}`} class="ticket-detail">
                    <dl>
                      <dt>状態</dt><dd>{stateLabelJa(t.state)}</dd>
                      <dt>レーン</dt><dd>{laneLabelJa(t.lane)}</dd>
                      <dt>受付番号</dt><dd>{t.displaySeq}</dd>
                      <dt>お名前</dt><dd>{t.nameKana ?? ""}</dd>
                      <dt>電話末尾</dt><dd>{t.phoneLast4 ?? ""}</dd>
                      {#if t.freeText !== null && t.freeText !== undefined}
                        <dt>ご相談内容</dt>
                        <dd class="freetext">{t.freeText}</dd>
                      {/if}
                      {#if t.appointmentAt !== null}
                        <dt>予約時刻</dt>
                        <dd>{t.appointmentAt.slice(11, 16)}</dd>
                      {/if}
                    </dl>
                  </div>
                {/if}
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

    <!-- batch confirmation dialog -->
    <Dialog
      bind:open={batchDialogOpen}
      title={m.call_batch_dialog_title()}
      onClose={() => (batchDialogOpen = false)}
    >
      <p>{m.call_batch_dialog_intro()}</p>
      <div class="batch-preset" role="radiogroup" aria-label="呼ぶ人数">
        {#each [2, 3, 5] as preset}
          <button
            type="button"
            role="radio"
            class="chip preset-chip"
            aria-checked={batchDialogN === preset}
            data-active={batchDialogN === preset ? "true" : undefined}
            onclick={() => (batchDialogN = preset)}
          >
            {preset} 人
          </button>
        {/each}
      </div>
      <p class="batch-note">
        待機列の先頭から {batchDialogN} 人を順番に呼び出します。
        現在の待機列は {filteredWaiting.length} 人です。
      </p>
      {#snippet actions()}
        <Button variant="ghost" onclick={() => (batchDialogOpen = false)} disabled={busy}>
          {m.call_batch_dialog_cancel()}
        </Button>
        <Button
          variant="primary"
          onclick={onCallBatchConfirm}
          disabled={busy || filteredWaiting.length === 0}
        >
          {m.call_batch_dialog_confirm({ count: String(batchDialogN) })}
        </Button>
      {/snippet}
    </Dialog>

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
  /* Pin the staff dashboard to the viewport below the layout
     header (4rem) so the whole page never spawns body scroll.
     Each column's `.cards` does its own overflow-y, keeping the
     topbar and per-column headers fixed. */
  .staff {
    position: fixed;
    top: 4rem;
    left: 0;
    right: 0;
    bottom: 0;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-sizing: border-box;
  }
  .chip {
    background: transparent;
    color: var(--color-fg-secondary);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-pill);
    padding: var(--space-2) var(--space-4);
    font: var(--text-label-sm);
    cursor: pointer;
  }
  .chip[data-active="true"] {
    background: var(--color-fg-primary);
    color: var(--color-bg-surface);
    border-color: transparent;
  }
  .waiting-col-header {
    gap: var(--space-3);
  }
  .col-title-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .col-title-row h2 {
    flex: 1;
  }
  .search {
    width: 100%;
    padding: var(--space-2) var(--space-3);
  }
  .primary-action {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-1);
  }
  .batch-link {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--color-fg-secondary);
    font: var(--text-body-sm);
    text-decoration: underline;
    cursor: pointer;
    text-align: center;
  }
  .batch-link:hover:not(:disabled),
  .batch-link:focus-visible {
    color: var(--color-fg-primary);
  }
  .batch-link:disabled {
    color: var(--color-fg-muted);
    cursor: not-allowed;
  }
  .col-header {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .lane-filter {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .filter-label {
    font: var(--text-label-sm);
    color: var(--color-fg-muted);
  }
  .batch-preset {
    display: flex;
    gap: var(--space-2);
    margin: var(--space-3) 0;
  }
  .preset-chip {
    flex: 1;
    padding: var(--space-3) var(--space-4);
    font: var(--text-body-md);
  }
  .batch-note {
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
    margin: 0;
  }
  .error {
    background: oklch(95% 0.05 25);
    color: var(--color-state-danger);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    margin: 0 0 var(--space-4);
    font: var(--text-body-sm);
  }
  /* `subgrid` on each `.col` opts every column into the kanban's
     own row grid, so the header row (row 1) auto-sizes to the
     tallest column header (= 待機列, which carries search +
     primary action + filter) and the other columns inherit that
     same height. Without subgrid the 待機列 header alone would
     stretch downward and the other columns' cards lists would
     start above it — visibly uneven. */
  .kanban {
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    gap: var(--space-4);
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  @media (min-width: 56rem) {
    .kanban {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }
  .col {
    display: grid;
    grid-template-rows: subgrid;
    grid-row: span 2;
    min-height: 0;
    min-width: 0;
  }
  .col > header {
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
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: var(--space-1);
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
  .waiting-card {
    position: relative;
  }
  /* Reserve a gutter on the card body for the absolutely-positioned
     checkbox so the lane chip (right edge of `.ticket-head`) never
     gets visually clipped underneath it. */
  .waiting-card .ticket-body-button .ticket-head {
    padding-right: 2.5rem;
  }
  .select-handle {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    display: inline-flex;
    align-items: center;
    z-index: 1;
  }
  .select-handle input[type="checkbox"] {
    width: 1.25rem;
    height: 1.25rem;
    cursor: pointer;
    accent-color: var(--color-accent-primary);
  }
  .ticket-body-button {
    appearance: none;
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    text-align: left;
    color: inherit;
    font: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
  }
  .ticket-body-button:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 4px;
    border-radius: var(--radius-md);
  }
  .ticket-detail {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--color-border-subtle);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .ticket-detail dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-1) var(--space-3);
    font: var(--text-body-sm);
  }
  .ticket-detail dt {
    color: var(--color-fg-muted);
    font: var(--text-label-sm);
  }
  .ticket-detail dd {
    margin: 0;
    color: var(--color-fg-primary);
  }
  .ticket-detail dd.freetext {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .detail-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
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
  .slot-chip[data-state="soon"] {
    color: oklch(40% 0.13 65);
    background: oklch(95% 0.07 65 / 50%);
  }
  .slot-chip[data-state="due"] {
    color: oklch(35% 0.18 30);
    background: oklch(92% 0.13 30 / 60%);
    font-weight: 600;
  }
  .slot-chip[data-state="overdue"] {
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
  .history-card {
    position: relative;
  }
  .history-card .ticket-body-button {
    color: var(--color-fg-muted);
  }
  .state-badge {
    font: var(--text-label-sm);
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
    background: var(--color-bg-subtle);
    color: var(--color-fg-secondary);
  }
  .state-badge[data-state="Served"] {
    background: oklch(95% 0.07 145);
    color: oklch(35% 0.13 145);
  }
  .state-badge[data-state="Cancelled"] {
    background: var(--color-bg-subtle);
    color: var(--color-fg-muted);
  }
  .state-badge[data-state="NoShow"] {
    background: oklch(95% 0.07 25);
    color: var(--color-state-danger);
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
