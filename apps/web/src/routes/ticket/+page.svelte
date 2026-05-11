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
    rescheduleTicket,
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
  import Help from "$lib/components/Help.svelte"
  import SlotPicker from "$lib/components/SlotPicker.svelte"
  import { errorMessage, helpText, loadingState, m } from "$lib/messages.js"
  import { buildShareRecoveryUrl, renderQrToDataUrl } from "$lib/qr.js"
  import {
    hasStaffToken,
    isTerminalState,
    purgeTicketCache,
    readTicketCache,
    writeTicketCache,
  } from "$lib/ticketCache.js"
  import { wsStatus } from "$lib/wsStatus.js"

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
  // ADR-0070 — atomic appointmentAt swap. The Dialog is only
  // openable while the ticket is reservation-laned and active; the
  // handle is read from the localStorage cache (already populated by
  // /ticket boot) so the customer just picks the new slot.
  let rescheduleDialogOpen = $state(false)
  let rescheduleNewISO: string | null = $state(null)
  let rescheduleBusy = $state(false)
  let rescheduleError: { tag: string; code: string; message: string } | null = $state(null)
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
  const isActive = $derived(
    ticket?.state === "Waiting" ||
      ticket?.state === "Called" ||
      ticket?.state === "Serving",
  )
  // Visibility guard for the reschedule button. Disable-on-WS-drop
  // is delegated to the button itself, mirroring how cancel handles
  // a feedState !== "open" tab.
  const canReschedule = $derived(isReservation && isActive)
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
    // Optimistic update: paint 「到着済み」 immediately so the customer
    // sees the result on press. The server-assigned `checkedInAt` will
    // overwrite this on the next projection broadcast (the server fires
    // one as part of the mutation pipeline). On failure we revert and
    // surface the error.
    const previousCheckedInAt = ticket.checkedInAt
    ticket = { ...ticket, checkedInAt: new Date().toISOString() }
    try {
      const r = await checkIn(stored.ticketId)
      if (!r.ok) {
        // Revert the optimistic flip — the customer sees a transient
        // 「到着済み」 then the original state plus the error card.
        ticket = ticket === null ? null : { ...ticket, checkedInAt: previousCheckedInAt }
        error = {
          tag: r.error._tag,
          code: r.error.code,
          message: errorMessage(r.error._tag),
        }
      }
      // Success: the optimistic value stays. The next WS broadcast +
      // selfEntry merge keeps state/lane/displaySeq fresh; a real
      // `checkedInAt` value would only arrive via a follow-up HTTP
      // (e.g. /recover boot path), and the local string-form ISO is
      // good enough for the 「到着済み」 badge in the meantime.
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
          message: errorMessage(r.error._tag),
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
        message: e instanceof Error ? e.message : errorMessage("NetworkError"),
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

  // Flip-card behaviour for the numeral hero. While the ticket is
  // Waiting and we know the position, the hero card has two faces:
  // 表 = 整理券番号、 裏 = 「あなたの前に N 人」。 The card flips
  // every 5s automatically, and a tap toggles it manually (which
  // also restarts the auto cycle so the user's intent stays
  // visible for at least one full interval).
  let flipped = $state(false)
  const flipShowable = $derived(
    ticket !== null && ticket.state === "Waiting" && positionInfo !== null,
  )
  let flipTimer: ReturnType<typeof setInterval> | undefined
  const startFlipTimer = (): void => {
    if (flipTimer !== undefined) clearInterval(flipTimer)
    flipTimer = setInterval(() => {
      flipped = !flipped
    }, 5000)
  }
  const stopFlipTimer = (): void => {
    if (flipTimer !== undefined) {
      clearInterval(flipTimer)
      flipTimer = undefined
    }
  }
  $effect(() => {
    if (flipShowable) {
      startFlipTimer()
    } else {
      stopFlipTimer()
      flipped = false
    }
    return stopFlipTimer
  })
  const onFlipClick = (): void => {
    if (!flipShowable) return
    flipped = !flipped
    startFlipTimer()
  }

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
          message: errorMessage(r.error._tag),
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

  const openRescheduleDialog = (): void => {
    rescheduleNewISO = ticket?.appointmentAt ?? null
    rescheduleError = null
    rescheduleDialogOpen = true
  }

  const onRescheduleConfirm = async (): Promise<void> => {
    if (stored === null || ticket === null || rescheduleNewISO === null) return
    rescheduleBusy = true
    try {
      const r = await rescheduleTicket(stored.ticketId, {
        nameKana: stored.nameKana,
        phoneLast4: stored.phoneLast4,
        newAppointmentAt: rescheduleNewISO,
      })
      if (!r.ok) {
        rescheduleError = {
          tag: r.error._tag,
          code: r.error.code,
          message: errorMessage(r.error._tag),
        }
        return
      }
      ticket = r.value.ticket
      rescheduleDialogOpen = false
      rescheduleNewISO = null
      // The mutation response is the authoritative ticket; the WS
      // projection broadcast that the server emits next will keep
      // /staff and other /ticket tabs in sync. No HTTP refresh needed.
    } finally {
      rescheduleBusy = false
    }
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
        const snap = parsed as ShopState
        snapshot = snap
        if (stored === null) return
        // ADR-0071 — v4 projection carries `state` on every entry,
        // so the common transition path (Waiting position shuffle,
        // appointmentAt edit, lane reorder) rides the WS feed
        // directly with no HTTP follow-up. A `ticketByHandle()`
        // round-trip is only spent on two rare boundaries:
        //   1. Waiting → Called   — we need a fresh `calledAt`
        //                            instant to drive the chime /
        //                            vibrate / notification (the
        //                            replay-protection key in
        //                            `maybeTriggerCalledAlert`).
        //   2. active → terminal — the id has fallen out of every
        //                            bucket; one HTTP call confirms
        //                            the terminal state and lets
        //                            `refresh()` purge the cache +
        //                            redirect to /recover.
        const selfEntry =
          snap.calling.find((t) => t.id === stored.ticketId) ??
          snap.serving.find((t) => t.id === stored.ticketId) ??
          snap.waitingPreview.find((t) => t.id === stored.ticketId) ??
          null
        if (selfEntry !== null) {
          const wasCalled = ticket?.state === "Called"
          const nowCalled = selfEntry.state === "Called"
          if (!wasCalled && nowCalled) {
            // Called transition observed — one HTTP fetch pulls the
            // server-assigned `calledAt` so the chime can fire and
            // the audit timestamp is real. `refresh()` runs the
            // alert internally.
            void refresh(stored)
            return
          }
          if (ticket !== null) {
            ticket = {
              ...ticket,
              state: selfEntry.state,
              lane: selfEntry.lane,
              displaySeq: selfEntry.displaySeq,
              appointmentAt: selfEntry.appointmentAt,
            }
          }
          return
        }
        if (ticket !== null && !isTerminalState(ticket.state)) {
          void refresh(stored)
        }
      },
      onState: (next) => {
        feedState = next
        wsStatus.set(next)
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
    <div class="numeral-hero-wrap" data-flipped={flipped ? "true" : undefined}>
      {#if flipShowable && positionInfo !== null}
        <button
          type="button"
          class="numeral-flip"
          onclick={onFlipClick}
          aria-label={flipped ? "整理券番号を表示" : "前の人数を表示"}
        >
          <div class="numeral-face numeral-face-front" data-state={ticket.state}>
            <span class="numeral-label">{m.numeral_label()}</span>
            <span class="numeral">{ticket.displaySeq}</span>
            <span class="state-tag">{stateLabel}</span>
          </div>
          <div class="numeral-face numeral-face-back" data-state={ticket.state}>
            <span class="numeral-label">あなたの前に</span>
            <span class="numeral">{positionInfo}</span>
            <span class="state-tag">人 待ち</span>
          </div>
        </button>
      {:else}
        <div class="numeral-face numeral-face-static" data-state={ticket.state}>
          <span class="numeral-label">{m.numeral_label()}</span>
          <span class="numeral">{ticket.displaySeq}</span>
          <span class="state-tag">{stateLabel}</span>
        </div>
      {/if}
    </div>

    {#if isReservation && minutesUntilAppointment !== null}
      <Card class="appointment-card">
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
          {#if canReschedule}
            <div class="appointment-action">
              <Button
                variant="secondary"
                size="md"
                fullWidth
                disabled={feedState !== "open"}
                onclick={openRescheduleDialog}
              >
                予約時刻を変更
              </Button>
              <Help text={helpText("reschedule")} label="予約時刻変更の説明を表示" />
            </div>
            <p class="reservation-modify-help">
              {m.reservation_modify_help()}
            </p>
          {/if}
        </div>
      </Card>
    {/if}

    {#if ticket.state === "Waiting" && notificationState === "default"}
      <Card class="notify-card">
        <div class="notif-opt-in">
          <p class="notif-msg">
            {m.notify_permission_question()}
            <Help text={helpText("notifyPermission")} label="通知の説明を表示" />
          </p>
          <p class="notif-help">{m.notify_permission_help()}</p>
          <Button variant="secondary" size="md" onclick={onRequestNotification}>
            通知を許可する
          </Button>
        </div>
      </Card>
    {/if}

    {#if feedState === "reconnecting"}
      <p class="banner" role="status" aria-live="polite">{loadingState("revalidate")}</p>
    {/if}

    {#if qrDataUrl !== null}
      <Card class="qr-card">
        <div class="qr">
          <img src={qrDataUrl} alt="QR (別端末で開く用 URL)" />
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
    <p class="loading">{loadingState("ticket")}</p>
  {/if}

  <Dialog
    bind:open={cancelDialogOpen}
    title="キャンセルしますか?"
    onClose={() => (cancelDialogOpen = false)}
  >
    <p>{m.confirm_cancel_body()}</p>
    <p class="dialog-hint">差し支えなければ理由をお書きください (任意):</p>
    <textarea bind:value={cancelReason} rows="2" placeholder="例: 都合がつかなくなった"></textarea>
    {#snippet actions()}
      <Button variant="ghost" onclick={() => (cancelDialogOpen = false)}>戻る</Button>
      <Button variant="destructive" disabled={cancelBusy} onclick={onCancelConfirm}>
        {cancelBusy ? "送信中…" : "キャンセル"}
      </Button>
    {/snippet}
  </Dialog>

  <Dialog
    bind:open={rescheduleDialogOpen}
    title="予約時刻を変更しますか?"
    onClose={() => (rescheduleDialogOpen = false)}
  >
    {#if ticket !== null && ticket.appointmentAt !== null && ticket.appointmentAt !== undefined}
      <p class="reschedule-current">
        現在の予約時刻:
        <strong>{ticket.appointmentAt.slice(11, 16)}</strong>
      </p>
    {/if}
    <p class="reschedule-help">{m.confirm_reschedule_body()}</p>
    <SlotPicker
      selectedISO={rescheduleNewISO}
      onSelect={(iso) => {
        rescheduleNewISO = iso
        rescheduleError = null
      }}
    />
    {#if rescheduleError !== null}
      <ErrorCard
        tag={rescheduleError.tag}
        code={rescheduleError.code}
        message={rescheduleError.message}
      />
    {/if}
    {#snippet actions()}
      <Button variant="ghost" onclick={() => (rescheduleDialogOpen = false)}>戻る</Button>
      <Button
        variant="primary"
        disabled={rescheduleBusy ||
          rescheduleNewISO === null ||
          rescheduleNewISO === ticket?.appointmentAt}
        onclick={onRescheduleConfirm}
      >
        {rescheduleBusy ? "送信中…" : "この時間に変更する"}
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
  /* Desktop only: pivot the page into a 2-column grid so the
     numeral and the QR share row 1 (huge number + scannable code
     side-by-side, as per user request). Every other card spans the
     full width below. On mobile the page stays a flex column
     (declared above) — see ticket-page's natural ordering for the
     mobile read order: numeral → appointment / position →
     reconnect banner → QR → cancel actions. The QR is intentionally
     after the position card so a customer scrolling on a phone
     sees「あなたの前に N 人」 before reaching the share-only QR. */
  @media (min-width: 48rem) {
    .ticket-page {
      max-width: 56rem;
      padding: 0 var(--space-6);
      display: grid;
      grid-template-columns: 1fr 1fr;
      column-gap: var(--space-6);
      row-gap: var(--space-6);
      align-items: start;
    }
    .ticket-page > .numeral-hero-wrap {
      grid-column: 1;
      grid-row: 1;
    }
    .ticket-page > .qr-card {
      grid-column: 2;
      grid-row: 1;
    }
    .ticket-page > .appointment-card,
    .ticket-page > .notify-card,
    .ticket-page > .actions,
    .ticket-page > .banner,
    .ticket-page > .loading {
      grid-column: 1 / -1;
    }
  }
  /* Flip-card structure. The wrap is the grid item; the flip is a
     position:relative container that hosts the two absolutely-
     positioned faces. The wrap also exposes the perspective so the
     rotation reads as depth instead of a 2-D shear. The "static"
     mode (= no positionInfo available) collapses to a plain
     numeral-face with no flip machinery. */
  .numeral-hero-wrap {
    perspective: 1200px;
  }
  .numeral-flip {
    position: relative;
    width: 100%;
    min-height: 16rem;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: pointer;
    transform-style: preserve-3d;
    transition: transform 600ms cubic-bezier(0.4, 0, 0.2, 1);
    display: block;
  }
  .numeral-hero-wrap[data-flipped="true"] .numeral-flip {
    transform: rotateY(180deg);
  }
  .numeral-flip:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 4px;
    border-radius: var(--radius-lg);
  }
  .numeral-face {
    text-align: center;
    padding: var(--space-8) var(--space-4);
    background: var(--color-bg-raised);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    justify-content: center;
    box-sizing: border-box;
  }
  .numeral-flip .numeral-face {
    position: absolute;
    inset: 0;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }
  .numeral-face-back {
    transform: rotateY(180deg);
  }
  @media (min-width: 48rem) {
    .numeral-flip {
      min-height: 20rem;
    }
    .numeral-face {
      padding: var(--space-10) var(--space-6);
    }
    .numeral-face .numeral {
      font-size: 8rem;
      line-height: 1;
    }
  }
  .numeral-face[data-state="Called"],
  .numeral-face[data-state="Serving"] {
    background: oklch(95% 0.07 65);
    border-color: var(--color-state-called);
  }
  .numeral-face[data-state="Served"] {
    background: oklch(95% 0.07 145);
    border-color: var(--color-state-serving);
  }
  .numeral-face[data-state="Cancelled"],
  .numeral-face[data-state="NoShow"] {
    background: var(--color-bg-subtle);
    color: var(--color-fg-muted);
  }
  .numeral-label {
    font: var(--text-label-sm);
    color: var(--color-fg-muted);
    letter-spacing: 0.05em;
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
    height: 100%;
    justify-content: center;
  }
  .qr img {
    border-radius: var(--radius-md);
    background: white;
    padding: var(--space-2);
    width: clamp(12rem, 60%, 18rem);
    height: auto;
    aspect-ratio: 1 / 1;
  }
  .qr-help {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
  }
  .qr-help p {
    margin: 0;
    color: var(--color-fg-secondary);
    font: var(--text-body-sm);
    text-align: center;
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
  .reschedule-current {
    margin: 0 0 var(--space-2);
    color: var(--color-fg-secondary);
    font: var(--text-body-md);
  }
  .reschedule-current strong {
    font: var(--text-numeral-sm);
    color: var(--color-fg-primary);
    margin-left: var(--space-2);
  }
  .reschedule-help {
    margin: 0 0 var(--space-4);
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
  }
  .appointment-action {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
  }
  .appointment-action :global(button) {
    flex: 1;
  }
  .reservation-modify-help {
    margin: var(--space-2) 0 0;
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
    text-align: left;
  }
  .dialog-hint {
    margin: var(--space-3) 0 var(--space-2);
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
  }
</style>
