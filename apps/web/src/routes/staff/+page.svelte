<script lang="ts">
  /**
   * Staff dashboard (S19 / ADR-0087) — the page is a thin shell on
   * top of the component library:
   *
   *   - `<Kanban>` owns the 5-column markup (descriptors.ts table)
   *   - `<ModalHost>` renders the discriminated `StaffModalState`
   *     ADT (states.ts) — one variant per confirm flow, so the
   *     2^N boolean explosion of the pre-refactor page collapses
   *     to N+1 named tags.
   *
   * The page itself only owns: auth (token + login form), the
   * cross-column search Dialog, the toast, the WS feed lifecycle,
   * and the API-call dispatcher. Every column-specific filter /
   * helper that used to live here is gone — the projection from
   * `StaffShopState` to columns is the descriptor table.
   */
  import type { StaffProjectionEntry, StaffShopState, TicketState } from "@booking/core"
  import { onDestroy, onMount } from "svelte"
  import {
    type ApiResult,
    callSpecific,
    connectQueueFeed,
    markNoShow,
    markServed,
    type QueueFeedHandle,
    recall,
    staffCancel,
    staffLogin,
    type Ticket,
  } from "$lib/api.js"
  import Button from "$lib/components/Button.svelte"
  import Card from "$lib/components/Card.svelte"
  import Dialog from "$lib/components/Dialog.svelte"
  import Kanban from "$lib/components/kanban/Kanban.svelte"
  import type { TicketAction } from "$lib/components/kanban/TicketCard.svelte"
  import ModalHost from "$lib/components/modal/ModalHost.svelte"
  import { closedStaff, type StaffModalState } from "$lib/components/modal/states.js"
  import Toast from "$lib/components/Toast.svelte"
  import { m } from "$lib/messages.js"
  import { isStaffShopState, shopStateStore } from "$lib/stores/shopState.svelte.js"
  import { clearStaffSession, markStaffLoggedIn } from "$lib/staffSession.js"
  import { writeLegacyStatus } from "$lib/wsStatus.js"

  /* ---------- state ---------- */
  // svelte-ignore state_referenced_locally
  // The initial value of `token` is read once from localStorage at
  // module init so the login form pre-fills when the staff has logged
  // in before. After mount the `bind:value` on the input drives the
  // reactive updates; we never want to "follow" localStorage past
  // the initial bootstrap.
  let token = $state(
    typeof window === "undefined" ? "" : (localStorage.getItem("queue.staffToken") ?? ""),
  )
  // svelte-ignore state_referenced_locally
  // `authenticated` snapshots the initial token presence at module
  // init only; subsequent state lives behind `onLogin` /
  // `onLogout` which assign `authenticated` explicitly.
  let authenticated = $state(token.length > 0)
  let busy = $state(false)
  let error: string | null = $state(null)
  let feed: QueueFeedHandle | undefined
  let prevWaitingCount: number | null = null

  // Single source of modal visibility — `StaffModalState` ADT, one
  // tag per confirm flow. The pre-refactor page tracked these as
  // N independent booleans + N payload fields; the ADT makes the
  // (open?, payload) pairing a type invariant.
  let modal = $state<StaffModalState>(closedStaff())

  // Cross-column search dialog. Distinct from the confirm-modal
  // family because it is a *navigation* affordance (find a card and
  // scroll to it), not a mutation. Kept as a standalone Dialog.
  let searchDialogOpen = $state(false)
  let searchQuery = $state("")
  let toast: {
    message: string
    variant?: "info" | "success" | "warning" | "danger"
    undoLabel?: string
    onUndo?: () => void
  } | null = $state(null)

  // Same state→label table the customer chips fall through; covers
  // the search-hit row badge.
  const stateLabelJa = (s: TicketState): string => {
    switch (s) {
      case "Waiting":
        return m.state_Waiting()
      case "Called":
        return m.state_Called()
      case "PendingNoShow":
        return m.state_Called()
      case "Served":
        return m.state_Served()
      case "NoShow":
        return m.state_NoShow()
      case "Cancelled":
        return m.state_Cancelled()
    }
  }

  // ADR-0074 — PendingNoShow grace TTL の elapsed / remaining 表示は
  // `markedAt` を要するが、 staff projection (S17 / ADR-0085) では PII
  // を絞り込んだ entry shape なので timestamp は載っていない。 残時間表示
  // は projection 拡張時に復活させる。

  /* ---------- derived ---------- */
  // The Kanban consumes a `StaffShopState`. Until the first WS
  // snapshot arrives the store is `null`; the page renders a
  // skeleton in that case (the `{#if shopState !== null}` branch).
  const shopState: StaffShopState | null = $derived.by(() => {
    const snap = shopStateStore.value
    if (snap === null) return null
    if (!isStaffShopState(snap)) return null
    return snap
  })

  // Watch the projection waiting count to surface a desktop
  // notification when new arrivals appear while the tab is hidden.
  $effect(() => {
    const snap = shopState
    if (snap === null) return
    const next = snap.waitingCount
    if (prevWaitingCount !== null && next > prevWaitingCount) {
      notifyArrival(next - prevWaitingCount)
    }
    prevWaitingCount = next
  })

  const searchHits: ReadonlyArray<StaffProjectionEntry> = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase()
    if (q.length === 0) return []
    const snap = shopState
    if (snap === null) return []
    const pool: ReadonlyArray<StaffProjectionEntry> = [
      ...snap.waitingPreview,
      ...snap.calling,
      ...snap.pendingNoShow,
      ...snap.serving,
      ...snap.terminal,
    ]
    return pool.filter((t) => {
      if (String(t.displaySeq) === q) return true
      if ((t.phoneLast4 ?? "") === q) return true
      const kana = (t.nameKana ?? "").toLowerCase()
      return kana.length > 0 && kana.includes(q)
    })
  })

  /**
   * Close the search dialog and scroll the matching card into
   * view. The `data-ticket-id` attribute on every TicketCard is
   * the anchor; the `.is-search-target` modifier paints a brief
   * highlight so the operator sees which card matched.
   */
  const focusOnTicket = (id: string): void => {
    searchDialogOpen = false
    searchQuery = ""
    if (typeof window === "undefined") return
    setTimeout(() => {
      const el = document.querySelector(`[data-ticket-id="${id}"]`)
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: "smooth", block: "center" })
        el.classList.add("is-search-target")
        setTimeout(() => el.classList.remove("is-search-target"), 1800)
      }
    }, 80)
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
  const startLiveFeed = (): void => {
    // S17 / ADR-0085 — `shopStateStore` is the single source of truth
    // for the staff projection. `connectQueueFeed` writes every WS
    // frame into it; the page reads the staff variant via the
    // `shopState` `$derived` above. No REST refetch is needed.
    if (feed === undefined) {
      feed = connectQueueFeed({
        onProjection: () => {
          // No-op: the store is already updated by `connectQueueFeed`,
          // and `$derived` propagates the snapshot into page state.
        },
        onState: (next) => {
          writeLegacyStatus(next)
        },
      })
    }
  }

  /**
   * Title table for the confirm-modal family. Returns an empty
   * string for `"none"` since `<ModalHost>` does not render
   * anything in that case. The switch is exhaustive over
   * `StaffModalState` so adding a variant fails to compile until
   * the title is supplied.
   */
  const modalTitle = (state: StaffModalState): string => {
    switch (state.tag) {
      case "none":
        return ""
      case "callConfirm":
        return "呼び出しの確認"
      case "servedConfirm":
        return "対応完了の確認"
      case "noShowConfirm":
        return "催促開始の確認"
      case "cancelConfirm":
        return "キャンセルの確認"
      case "batchCall":
        return "一括呼び出しの確認"
      case "ticketDetail":
        return "整理券の詳細"
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
  }

  const showToast = (
    message: string,
    variant?: "info" | "success" | "warning" | "danger",
    undoLabel?: string,
    onUndo?: () => void,
  ) => {
    toast = { message, variant, undoLabel, onUndo }
  }

  /* ---------- auth ----------
   *
   * The staff login round-trip discards the response body's JWT
   * (REST mutations keep using `x-staff-token` for now) but the
   * `Set-Cookie` side-effect installs `__Host-staff_session`,
   * which the WebSocket `/queue/feed` upgrade carries so the
   * worker tags the socket `cap:staff` (ADR-0083 part 2).
   * Without that cookie the WS opens anonymous and the Kanban
   * stays at the "読み込み中..." skeleton (ADR-0085). The
   * envelope's `debug` field (ADR-0089) surfaces the failure
   * reason on a 401 so the operator sees *why* the credential
   * was rejected (length / value mismatch with sanitized
   * head/tail preview).
   */
  const installSessionCookie = async (rawToken: string): Promise<boolean> => {
    const r = await staffLogin(rawToken)
    if (!r.ok) {
      const debug = (r.error as { readonly debug?: { readonly hint?: string } }).debug
      error =
        debug?.hint !== undefined
          ? `login: ${r.error._tag} — ${debug.hint}`
          : `login: ${r.error._tag}`
      return false
    }
    return true
  }

  const onLogin = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (token.length === 0) return
    busy = true
    error = null
    try {
      if (!(await installSessionCookie(token))) return
      localStorage.setItem("queue.staffToken", token)
      markStaffLoggedIn()
      authenticated = true
      ensureNotificationPermission()
      await startLiveFeed()
    } finally {
      busy = false
    }
  }

  const onLogout = (): void => {
    clearStaffSession()
    token = ""
    authenticated = false
    feed?.close()
    feed = undefined
    prevWaitingCount = null
    error = null
    modal = closedStaff()
  }

  /* ---------- operator actions ----------
   *
   * `handleKanbanAction` is the single inbound from
   * `<TicketCard>`. The TicketAction → StaffModalState mapping is
   * encoded here: mutating actions open a confirm modal, the
   * `recall` action goes straight through (with undo on the toast).
   * The corresponding DO RPC is fired from the modal's confirm
   * button via `runConfirmedAction`.
   */
  const handleKanbanAction = (action: TicketAction, entry: StaffProjectionEntry): void => {
    switch (action) {
      case "call":
        modal = { tag: "callConfirm", ticketId: entry.id }
        return
      case "served":
        modal = { tag: "servedConfirm", ticketId: entry.id }
        return
      case "noShow":
        modal = { tag: "noShowConfirm", ticketId: entry.id }
        return
      case "cancel":
        modal = { tag: "cancelConfirm", ticketId: entry.id, reason: "staff-cancel" }
        return
      case "recall":
        void onRecallTicket(entry.id)
        return
    }
  }

  const onCallSpecific = (ticketId: string) =>
    runAction(
      "call-specific",
      () => callSpecific(token, ticketId),
      (v) => {
        const t = (v as { ticket: Ticket }).ticket
        showToast(`#${t.displaySeq} を呼び出しました`, "info", "取消", () => onRecallTicket(t.id))
      },
    )

  const onMarkServed = (ticketId: string) =>
    runAction("mark-served", () => markServed(token, ticketId), () => showToast("対応完了", "success"))

  // ADR-0074 — the「来なかった」 button now opens a grace window
  // (PendingNoShow) instead of terminating the ticket immediately.
  // The customer's /ticket page surfaces a modal where they can
  // respond 「遅れる」 or 「来ない」; the DO alarm sweeps after
  // GRACE_TTL_MIN if neither.
  const onMarkNoShow = (ticketId: string) =>
    runAction("mark-no-show", () => markNoShow(token, ticketId), () =>
      showToast("催促を開始しました (お客様の応答待ち)", "warning"),
    )

  const onRecallTicket = (ticketId: string) =>
    runAction("recall", () => recall(token, ticketId), () => showToast("取り消しました", "info"))

  const onStaffCancel = (ticketId: string, reason: string) =>
    runAction("cancel", () => staffCancel(token, ticketId, reason), () => showToast("キャンセル", "warning"))

  /**
   * Run the action wired to the open modal, then close it. The
   * switch is exhaustive over `StaffModalState`; adding a variant
   * fails to compile until both the wiring here and the body
   * snippet below are extended.
   */
  const runConfirmedAction = async (state: StaffModalState): Promise<void> => {
    switch (state.tag) {
      case "none":
        return
      case "callConfirm":
        await onCallSpecific(state.ticketId)
        break
      case "servedConfirm":
        await onMarkServed(state.ticketId)
        break
      case "noShowConfirm":
        await onMarkNoShow(state.ticketId)
        break
      case "cancelConfirm":
        await onStaffCancel(state.ticketId, state.reason)
        break
      case "batchCall":
        // Batch-call flow not wired yet — the variant exists so
        // the ADT can grow into it without re-shaping the host.
        break
      case "ticketDetail":
        // Read-only modal; no action to run on close.
        break
    }
    modal = closedStaff()
  }

  /* ---------- lifecycle ---------- */
  onMount(() => {
    if (authenticated) {
      // Token came from localStorage at script init; the shared
      // store needs to mirror it so the layout's ログアウト button
      // renders without waiting for an explicit login event.
      markStaffLoggedIn()
      ensureNotificationPermission()
      // Refresh the __Host-staff_session cookie via a silent
      // login round-trip. The cookie has an 8h TTL — past that
      // (or after a manual cookie-jar wipe) the WS upgrade falls
      // back to anonymous and the Kanban stays at the
      // "読み込み中..." skeleton. Re-installing the cookie up
      // front keeps the page reload path symmetric with the
      // explicit login form (ADR-0085).
      void (async () => {
        if (await installSessionCookie(token)) {
          await startLiveFeed()
        } else {
          authenticated = false
        }
      })()
    }
  })

  onDestroy(() => {
    feed?.close()
    writeLegacyStatus("none")
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
    <button
      type="button"
      class="search-toggle"
      onclick={() => (searchDialogOpen = true)}
      aria-label="待機客を検索"
      title="検索"
    >
      🔍
    </button>

    {#if error !== null}
      <p class="error" role="alert">{error}</p>
    {/if}

    {#if shopState !== null}
      <Kanban state={shopState} onAction={handleKanbanAction} />
    {:else}
      <p class="skeleton">読み込み中…</p>
    {/if}

    <!-- Confirm-modal family. The `<ModalHost>` renders nothing
         when `modal.tag === "none"`; otherwise it wraps a Dialog
         and the snippet narrows on the discriminator tag. -->
    <ModalHost
      state={modal}
      title={modalTitle(modal)}
      onClose={() => (modal = closedStaff())}
    >
      {#snippet children(state)}
        {#if state.tag === "callConfirm"}
          <p>この整理券を呼び出しますか?</p>
          <div class="modal-actions">
            <Button variant="ghost" onclick={() => (modal = closedStaff())} disabled={busy}>
              閉じる
            </Button>
            <Button onclick={() => runConfirmedAction(state)} disabled={busy}>
              呼び出す
            </Button>
          </div>
        {:else if state.tag === "servedConfirm"}
          <p>対応完了として記録しますか?</p>
          <div class="modal-actions">
            <Button variant="ghost" onclick={() => (modal = closedStaff())} disabled={busy}>
              閉じる
            </Button>
            <Button onclick={() => runConfirmedAction(state)} disabled={busy}>
              対応完了
            </Button>
          </div>
        {:else if state.tag === "noShowConfirm"}
          <p>来店なしとして催促を開始しますか? お客様の応答を待ちます。</p>
          <div class="modal-actions">
            <Button variant="ghost" onclick={() => (modal = closedStaff())} disabled={busy}>
              閉じる
            </Button>
            <Button onclick={() => runConfirmedAction(state)} disabled={busy}>
              催促開始
            </Button>
          </div>
        {:else if state.tag === "cancelConfirm"}
          <p>この整理券をキャンセルしますか? 取り消せません。</p>
          <div class="modal-actions">
            <Button variant="ghost" onclick={() => (modal = closedStaff())} disabled={busy}>
              閉じる
            </Button>
            <Button variant="destructive" onclick={() => runConfirmedAction(state)} disabled={busy}>
              キャンセル
            </Button>
          </div>
        {:else if state.tag === "batchCall"}
          <p>{state.ticketIds.length} 件を呼び出しますか?</p>
          <div class="modal-actions">
            <Button variant="ghost" onclick={() => (modal = closedStaff())} disabled={busy}>
              閉じる
            </Button>
            <Button onclick={() => runConfirmedAction(state)} disabled={busy}>
              呼び出す
            </Button>
          </div>
        {:else if state.tag === "ticketDetail"}
          <p>整理券 ID: {state.ticketId}</p>
          <div class="modal-actions">
            <Button onclick={() => (modal = closedStaff())}>閉じる</Button>
          </div>
        {/if}
      {/snippet}
    </ModalHost>

    <!-- cross-column search dialog -->
    <Dialog
      bind:open={searchDialogOpen}
      title="待機客を検索"
      onClose={() => {
        searchDialogOpen = false
        searchQuery = ""
      }}
    >
      <input
        type="search"
        bind:value={searchQuery}
        placeholder="名前 (一部) / 末尾4桁 / 受付番号"
        aria-label="検索キーワード"
        class="search-input"
      />
      {#if searchQuery.trim().length > 0}
        {#if searchHits.length === 0}
          <p class="search-empty">該当する整理券は見つかりませんでした。</p>
        {:else}
          <ul class="search-hits" role="list">
            {#each searchHits as t (t.id)}
              <li>
                <button
                  type="button"
                  class="search-hit"
                  onclick={() => focusOnTicket(t.id)}
                >
                  <span class="hit-displayseq">{t.displaySeq}</span>
                  <span class="hit-meta">
                    <span class="hit-kana">{t.nameKana ?? ""}</span>
                    <span class="hit-last4">{t.phoneLast4 ?? ""}</span>
                  </span>
                  <span class="state-badge" data-state={t.state}>{stateLabelJa(t.state)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="search-empty">名前・電話末尾 4 桁・受付番号 のいずれかを入力してください。</p>
      {/if}
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
     header (4rem) so the whole page never spawns body scroll. The
     `<Kanban>` owns the column overflow internally. */
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
  .search-toggle {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    z-index: 5;
    width: 2.5rem;
    height: 2.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg-raised);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-pill);
    cursor: pointer;
    font-size: 1.1rem;
  }
  .search-toggle:hover,
  .search-toggle:focus-visible {
    background: var(--color-bg-subtle);
    border-color: var(--color-fg-secondary);
  }
  .search-input {
    width: 100%;
    box-sizing: border-box;
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg-subtle);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-3);
  }
  .search-empty {
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
    margin: 0;
  }
  .search-hits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-height: 24rem;
    overflow-y: auto;
  }
  .search-hit {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg-subtle);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: left;
    color: inherit;
  }
  .search-hit:hover,
  .search-hit:focus-visible {
    background: var(--color-bg-raised);
    border-color: var(--color-fg-secondary);
  }
  .hit-displayseq {
    font: var(--text-numeral-sm);
    font-variant-numeric: tabular-nums;
    color: var(--color-fg-primary);
  }
  .hit-meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    flex: 1;
    min-width: 0;
    font: var(--text-body-sm);
    color: var(--color-fg-secondary);
  }
  .hit-last4 {
    font: var(--text-mono-sm);
    color: var(--color-fg-muted);
  }
  .error {
    background: oklch(95% 0.05 25);
    color: var(--color-state-danger);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    margin: 0 0 var(--space-4);
    font: var(--text-body-sm);
  }
  .skeleton {
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
    text-align: center;
    padding: var(--space-8);
    flex: 1;
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
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }
  .toast-host {
    position: fixed;
    bottom: var(--space-6);
    right: var(--space-6);
    z-index: 1000;
  }
  :global(.is-search-target) {
    box-shadow: 0 0 0 2px var(--color-accent-primary);
    border-radius: var(--radius-lg);
    transition: box-shadow 1800ms ease-out;
  }
</style>
