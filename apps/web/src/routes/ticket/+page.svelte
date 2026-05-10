<script lang="ts">
  import { goto } from "$app/navigation"
  import { page } from "$app/state"
  import { onDestroy, onMount } from "svelte"
  import {
    cancelTicket,
    checkIn,
    connectQueueFeed,
    type ProjectionEntry,
    type QueueFeedHandle,
    type QueueFeedState,
    type ShopState,
    shopState,
    type Ticket,
    ticketByHandle,
  } from "$lib/api.js"
  import {
    clearAlertMemory,
    maybeTriggerCalledAlert,
    type NotificationPermissionState,
    notificationPermissionState,
    requestNotificationPermission,
  } from "$lib/calledAlert.js"
  import Button from "$lib/components/Button.svelte"
  import Card from "$lib/components/Card.svelte"
  import Dialog from "$lib/components/Dialog.svelte"
  import ErrorCard from "$lib/components/ErrorCard.svelte"
  import { buildShareRecoveryUrl, renderQrToDataUrl } from "$lib/qr.js"
  import {
    hasStaffToken,
    isTerminalState,
    purgeTicketCache,
    readTicketCache,
    writeTicketCache,
  } from "$lib/ticketCache.js"

  type Stored = { ticketId: string; nameKana: string; phoneLast4: string }

  let stored: Stored | null = $state(null)
  let ticket: Ticket | null = $state(null)
  let snapshot: ShopState | null = $state(null)
  let qrDataUrl: string | null = $state(null)
  let shareUrl: string | null = $state(null)
  let error: { tag: string; code: string; message: string } | null = $state(null)
  let cancelDialogOpen = $state(false)
  let cancelReason = $state("")
  let cancelBusy = $state(false)
  let feedState: QueueFeedState = $state("connecting")
  let notificationState: NotificationPermissionState = $state("unsupported")
  let feed: QueueFeedHandle | undefined
  let now = $state(Date.now())
  let checkInBusy = $state(false)
  let countdownTick: ReturnType<typeof setInterval> | undefined

  // ADR-0068: customer can hit 「到着しました」 once `now ≥ appointmentAt - 10min`.
  const CHECK_IN_WINDOW_MS = 10 * 60 * 1000

  const isReservation = $derived(
    ticket?.appointmentAt !== null && ticket?.appointmentAt !== undefined,
  )
  const appointmentMs = $derived(
    ticket?.appointmentAt !== null && ticket?.appointmentAt !== undefined
      ? Date.parse(ticket.appointmentAt)
      : null,
  )
  const minutesUntilAppointment = $derived(
    appointmentMs !== null ? Math.round((appointmentMs - now) / 60000) : null,
  )
  const checkInAvailable = $derived(
    appointmentMs !== null &&
      ticket?.state === "Waiting" &&
      ticket.checkedInAt === null &&
      now >= appointmentMs - CHECK_IN_WINDOW_MS,
  )
  const alreadyCheckedIn = $derived(ticket?.checkedInAt !== null && ticket?.checkedInAt !== undefined)

  const onCheckIn = async (): Promise<void> => {
    if (stored === null || ticket === null) return
    checkInBusy = true
    try {
      const r = await checkIn(stored.ticketId)
      if (!r.ok) {
        error = {
          tag: r.error._tag,
          code: r.error.code,
          message: messageOf(r.error._tag),
        }
        return
      }
      // Refresh to read the new checkedInAt.
      await refresh(stored)
    } finally {
      checkInBusy = false
    }
  }

  // ADR-0069: localStorage cache is convenience only — the
  // server-side `GET /tickets/by-handle` is the primary recovery
  // capability. Cache read order:
  //   1. Legacy `?id&k&p` URL (ADR-0064) → migrate into the cache
  //      and rewrite the URL to drop PII.
  //   2. localStorage cache (`queue.ticket.v2` or the migrated
  //      `queue.ticket` sessionStorage from ADR-0064).
  //   3. Fall through → /recover prompts for the handle.
  const readStored = (): Stored | null => {
    if (typeof window === "undefined") return null
    const params = page.url.searchParams
    const id = params.get("id")
    const k = params.get("k")
    const p = params.get("p")
    if (id !== null && k !== null && p !== null) {
      const migrated: Stored = { ticketId: id, nameKana: k, phoneLast4: p }
      writeTicketCache(migrated)
      // ADR-0069: strip PII from URL bar / browser history.
      window.history.replaceState(null, "", `/ticket?id=${encodeURIComponent(id)}`)
      return migrated
    }
    const cached = readTicketCache()
    if (cached === null) return null
    // If the URL carries a different `?id=…` than the cache, the
    // recipient hit the page via someone else's share link — let
    // /recover ask for their own handle.
    if (id !== null && id !== cached.ticketId) return null
    return {
      ticketId: cached.ticketId,
      nameKana: cached.nameKana,
      phoneLast4: cached.phoneLast4,
    }
  }

  const refresh = async (id: Stored): Promise<void> => {
    try {
      const r = await ticketByHandle({ nameKana: id.nameKana, phoneLast4: id.phoneLast4 })
      if (!r.ok) {
        // 404 TicketNotFound = the handle no longer holds an active
        // ticket (release after Served / Cancelled / NoShow, or the
        // cache survived a stale device). Purge + bounce to /recover.
        if (r.error._tag === "TicketNotFound") {
          purgeTicketCache()
          clearAlertMemory()
          await goto("/recover")
          return
        }
        error = {
          tag: r.error._tag,
          code: r.error.code,
          message: messageOf(r.error._tag),
        }
        return
      }
      const t = r.value.ticket
      ticket = t
      error = null
      writeTicketCache({
        ticketId: t.id,
        nameKana: t.nameKana ?? id.nameKana,
        phoneLast4: t.phoneLast4 ?? id.phoneLast4,
        lastKnownState: t.state,
      })
      // Called observation — fires chime / vibrate / notification on
      // the **first** transition into Called (per-calledAt instant).
      // A Recall → re-Call mints a fresh calledAt and the alert fires
      // again; a tab reload while the ticket is already Called does
      // not re-fire (the calledAt is unchanged).
      maybeTriggerCalledAlert({
        state: t.state,
        calledAt: "calledAt" in t ? t.calledAt : null,
        displaySeq: t.displaySeq,
      })
      // Terminal observation — keep the view rendered so the
      // customer sees "対応完了" / "キャンセル済", but release the
      // cache so the next mount falls through to /recover.
      if (isTerminalState(t.state)) {
        purgeTicketCache()
        clearAlertMemory()
      }
      const s = await shopState()
      if (s.ok) snapshot = s.value
      const origin = window.location.origin
      const url = buildShareRecoveryUrl(origin)
      shareUrl = url
      qrDataUrl = await renderQrToDataUrl(url)
    } catch (e) {
      error = {
        tag: "NetworkError",
        code: "E_NET_FAIL",
        message: e instanceof Error ? e.message : "ネットワーク接続を確認してください",
      }
    }
  }

  const positionInfo = $derived.by(() => {
    if (ticket === null || snapshot === null) return null
    if (ticket.state !== "Waiting") return null
    const sameLane = snapshot.waitingPreview.filter(
      (t: ProjectionEntry) => t.lane === ticket?.lane,
    )
    const idx = sameLane.findIndex((t) => t.id === ticket?.id)
    return idx >= 0 ? idx : null
  })

  const stateLabel = $derived.by(() => {
    if (ticket === null) return ""
    switch (ticket.state) {
      case "Waiting":
        return "お待ちください"
      case "Called":
      case "Serving":
        return "呼ばれました"
      case "Served":
        return "対応完了"
      case "NoShow":
        return "キャンセル扱い (時間切れ)"
      case "Cancelled":
        return "キャンセル済"
    }
  })

  const messageOf = (tag: string): string => {
    switch (tag) {
      case "TicketNotFound":
        return "番号が見つかりません。 名前 / 末尾 4 桁を確認してください"
      case "PhoneMismatch":
        return "名前または電話番号末尾が一致しません"
      case "CheckInTooEarly":
        return "受付開始時刻まで少々お待ちください"
      case "AppointmentRequiredForReservationLane":
        return "この操作は予約のチケットでのみ可能です"
      default:
        return "情報を取得できませんでした"
    }
  }

  const onCopyUrl = async () => {
    if (shareUrl === null) return
    try {
      await navigator.clipboard.writeText(shareUrl)
    } catch {
      // clipboard API 不可 (insecure context) — fallback はしない
    }
  }

  const onCancelConfirm = async () => {
    if (stored === null) return
    cancelBusy = true
    try {
      const r = await cancelTicket(stored.ticketId, {
        nameKana: stored.nameKana,
        phoneLast4: stored.phoneLast4,
        reason: cancelReason.length > 0 ? cancelReason : "customer-cancel",
      })
      if (!r.ok) {
        error = {
          tag: r.error._tag,
          code: r.error.code,
          message: messageOf(r.error._tag),
        }
        return
      }
      ticket = r.value.ticket
      cancelDialogOpen = false
      cancelReason = ""
    } finally {
      cancelBusy = false
    }
  }

  const onRequestNotification = async (): Promise<void> => {
    notificationState = await requestNotificationPermission()
  }

  onMount(async () => {
    // Stage 10: staff session sandbox — operator at the keyboard
    // shouldn't impersonate a customer view, even by accident.
    if (hasStaffToken()) {
      await goto("/staff")
      return
    }
    notificationState = notificationPermissionState()
    stored = readStored()
    if (stored === null) {
      // No URL params, no cache → the customer landed on /ticket
      // without a handle. ADR-0069 routes them to /recover to type
      // (kana, last4); the form's submit handler will land them
      // back here with the cache populated.
      await goto("/recover")
      return
    }
    await refresh(stored)
    feed = connectQueueFeed({
      onProjection: (parsed) => {
        snapshot = parsed as ShopState
        // ADR-0061 — the WS broadcasts the public projection only.
        // The customer's own state (Waiting → Called → Serving →
        // Served) lives behind /api/v1/tickets/me and is never
        // serialised onto the feed. Refetch on every broadcast so a
        // staff CallNext / MarkServed / Recall flips this tab's
        // hero state — without this, only freshly-loaded tabs would
        // see the transition (the 「呼ばれました」 hero would be
        // stuck on the original /ticket tab while a tab opened from
        // the recovery URL renders correctly).
        if (stored !== null) void refresh(stored)
      },
      onState: (next) => {
        feedState = next
      },
    })
    // 1Hz countdown tick — only mounts client-side via onMount, so
    // SSR never spawns a setInterval that would never clear.
    countdownTick = setInterval(() => {
      now = Date.now()
    }, 1000)
  })

  onDestroy(() => {
    feed?.close()
    if (countdownTick !== undefined) clearInterval(countdownTick)
  })
</script>

<svelte:head>
  <title>ご自分の番号 — 整理券</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<section class="ticket-page">
  {#if error !== null}
    <ErrorCard
      tag={error.tag}
      code={error.code}
      message={error.message}
      retryLabel="再読み込み"
      onRetry={() => stored !== null && refresh(stored)}
    />
  {/if}

  {#if ticket !== null}
    <div class="numeral-hero" data-state={ticket.state}>
      <span class="state-tag">{stateLabel}</span>
      <span class="numeral">{ticket.displaySeq}</span>
      <span class="lane">
        {ticket.lane === "priority"
          ? "優先"
          : ticket.lane === "reservation"
            ? "予約"
            : "通常"}
      </span>
    </div>

    {#if isReservation && minutesUntilAppointment !== null}
      <Card>
        <div class="appointment">
          <span class="appointment-label">予約時刻</span>
          <span class="appointment-time">{ticket.appointmentAt?.slice(11, 16) ?? ""}</span>
          {#if alreadyCheckedIn}
            <span class="appointment-badge badge-arrived">到着済み</span>
          {:else if minutesUntilAppointment > 0}
            <span class="appointment-countdown">
              あと {minutesUntilAppointment} 分
            </span>
          {:else}
            <span class="appointment-countdown overdue">時間です</span>
          {/if}
          {#if checkInAvailable && !alreadyCheckedIn}
            <Button
              size="md"
              fullWidth
              disabled={checkInBusy}
              onclick={onCheckIn}
            >
              {checkInBusy ? "送信中…" : "到着しました"}
            </Button>
          {/if}
        </div>
      </Card>
    {:else if ticket.state === "Waiting" && positionInfo !== null}
      <Card>
        <p class="position">
          あなたの前に <strong>{positionInfo}</strong> 人
        </p>
      </Card>
    {/if}

    {#if ticket.state === "Waiting" && notificationState === "default"}
      <Card>
        <div class="notif-opt-in">
          <p class="notif-msg">呼ばれたときに通知を受け取りますか?</p>
          <p class="notif-help">音とバイブと画面通知でお知らせします。</p>
          <Button variant="secondary" size="md" onclick={onRequestNotification}>
            通知を許可する
          </Button>
        </div>
      </Card>
    {/if}

    {#if feedState === "reconnecting"}
      <p class="banner" role="status" aria-live="polite">再接続中…</p>
    {/if}

    {#if qrDataUrl !== null}
      <Card>
        <div class="qr">
          <img src={qrDataUrl} alt="QR (別端末で開く用 URL)" width="240" height="240" />
          <div class="qr-help">
            <p>別の端末で開けます。 名前 (カタカナ) と電話末尾を入力して開きます。</p>
            <Button variant="secondary" size="md" onclick={onCopyUrl}>URL をコピー</Button>
          </div>
        </div>
      </Card>
    {/if}

    {#if ticket.state === "Waiting" || ticket.state === "Called" || ticket.state === "Serving"}
      <div class="actions">
        <Button
          variant="ghost"
          size="md"
          disabled={feedState !== "open"}
          onclick={() => (cancelDialogOpen = true)}
        >
          キャンセル
        </Button>
      </div>
    {/if}
  {:else if error === null}
    <p class="loading">読み込み中…</p>
  {/if}

  <Dialog
    bind:open={cancelDialogOpen}
    title="キャンセルしますか?"
    onClose={() => (cancelDialogOpen = false)}
  >
    <p>キャンセル後は再発行が必要です。 理由 (任意):</p>
    <textarea bind:value={cancelReason} rows="2" placeholder="例: 都合がつかなくなった"></textarea>
    {#snippet actions()}
      <Button variant="ghost" onclick={() => (cancelDialogOpen = false)}>戻る</Button>
      <Button variant="destructive" disabled={cancelBusy} onclick={onCancelConfirm}>
        {cancelBusy ? "送信中…" : "キャンセル"}
      </Button>
    {/snippet}
  </Dialog>
</section>

<style>
  .ticket-page {
    max-width: 28rem;
    margin: var(--space-8) auto;
    padding: 0 var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }
  .numeral-hero {
    text-align: center;
    padding: var(--space-8) var(--space-4);
    background: var(--color-bg-raised);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .numeral-hero[data-state="Called"],
  .numeral-hero[data-state="Serving"] {
    background: oklch(95% 0.07 65);
    border-color: var(--color-state-called);
  }
  .numeral-hero[data-state="Served"] {
    background: oklch(95% 0.07 145);
    border-color: var(--color-state-serving);
  }
  .numeral-hero[data-state="Cancelled"],
  .numeral-hero[data-state="NoShow"] {
    background: var(--color-bg-subtle);
    color: var(--color-fg-muted);
  }
  .numeral {
    font: var(--text-numeral-hero);
    font-variant-numeric: tabular-nums;
    color: var(--color-fg-primary);
  }
  .state-tag {
    font: var(--text-label-md);
    color: var(--color-fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .lane {
    font: var(--text-label-sm);
    color: var(--color-fg-muted);
  }
  .position {
    text-align: center;
    margin: 0;
    font: var(--text-body-md);
  }
  .position strong {
    font: var(--text-numeral-md);
    color: var(--color-fg-primary);
    font-variant-numeric: tabular-nums;
    margin: 0 var(--space-2);
  }
  .notif-opt-in {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    text-align: center;
  }
  .notif-msg {
    font: var(--text-body-md);
    color: var(--color-fg-primary);
    margin: 0;
  }
  .notif-help {
    font: var(--text-body-sm);
    color: var(--color-fg-muted);
    margin: 0 0 var(--space-2);
  }
  .qr {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    align-items: center;
  }
  .qr img {
    border-radius: var(--radius-md);
    background: white;
    padding: var(--space-2);
  }
  .qr-help p {
    margin: 0 0 var(--space-2);
    color: var(--color-fg-secondary);
    font: var(--text-body-sm);
  }
  .actions {
    display: flex;
    justify-content: center;
  }
  .loading {
    text-align: center;
    color: var(--color-fg-muted);
  }
  .banner {
    background: oklch(95% 0.07 65);
    color: oklch(40% 0.13 65);
    border: 1px solid oklch(85% 0.15 65);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    margin: 0;
    text-align: center;
  }
  .appointment {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: center;
    text-align: center;
  }
  .appointment-label {
    font: var(--text-label-sm);
    color: var(--color-fg-muted);
  }
  .appointment-time {
    font: var(--text-numeral-sm);
    color: var(--color-fg-primary);
  }
  .appointment-countdown {
    font: var(--text-body-md);
    color: var(--color-fg-secondary);
  }
  .appointment-countdown.overdue {
    color: var(--color-state-called);
    font-weight: 600;
  }
  .appointment-badge {
    display: inline-block;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-pill);
    font: var(--text-label-sm);
  }
  .badge-arrived {
    background: oklch(95% 0.07 145);
    color: oklch(35% 0.13 145);
  }
  textarea {
    width: 100%;
    background: var(--color-bg-subtle);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    margin-top: var(--space-2);
    resize: vertical;
  }
</style>
