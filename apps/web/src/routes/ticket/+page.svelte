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
  import StateStepper from "$lib/components/StateStepper.svelte"
  import { errorMessage, helpText, loadingState, m } from "$lib/messages.js"
  import { subscribeToPush, unsubscribeFromPush } from "$lib/pushSubscribe.js"
  import { buildShareRecoveryUrl, renderQrToDataUrl } from "$lib/qr.js"
  import { vapidPublicKey } from "$lib/vapidPublicKey.js"
  import {
    hasStaffToken,
    isTerminalState,
    purgeTicketCache,
    readTicketCache,
    writeTicketCache,
  } from "$lib/ticketCache.js"

  type Stored = { ticketId: string; nameKana: string; phoneLast4: string }

  let stored = $state<Stored | null>(null)
  let ticket = $state<Ticket | null>(null)
  let snapshot = $state<ShopState | null>(null)
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
  // ADR-0073: subscribeToPush is a multi-step async flow; on unmount or
  // terminal-state observation we abort it so a late-resolving subscribe
  // does not write a row that we have just decided not to want.
  const subscribeAbort = new AbortController()
  let now = $state(Date.now())
  let checkInBusy = $state(false)
  let countdownTick: ReturnType<typeof setInterval> | undefined

  // ADR-0068: customer can hit 「到着しました」 once `now ≥ appointmentAt - 10min`.
  const CHECK_IN_WINDOW_MS = 10 * 60 * 1000

  // M1: lane invariant guarantees reservation ⇔ appointmentAt !== null
  // (ADR-0066), but a defensive lane check costs nothing and prevents
  // a misconfigured fixture / future bug from showing reservation UI
  // to a walk-in customer.
  const isReservation = $derived(
    ticket !== null && ticket.lane === "reservation" && ticket.appointmentAt !== null,
  )
  const isActive = $derived(
    ticket !== null &&
      (ticket.state === "Waiting" || ticket.state === "Called" || ticket.state === "Overdue"),
  )
  // Visibility guard for the reschedule button. Disable-on-WS-drop
  // is delegated to the button itself, mirroring how cancel handles
  // a feedState !== "open" tab.
  const canReschedule = $derived(isReservation && isActive)
  const appointmentMs = $derived(
    ticket !== null && ticket.appointmentAt !== null ? Date.parse(ticket.appointmentAt) : null,
  )
  const minutesUntilAppointment = $derived(
    appointmentMs !== null ? Math.round((appointmentMs - now) / 60000) : null,
  )
  const checkInAvailable = $derived(
    appointmentMs !== null &&
      ticket !== null &&
      ticket.state === "Waiting" &&
      ticket.checkedInAt === null &&
      now >= appointmentMs - CHECK_IN_WINDOW_MS,
  )
  const alreadyCheckedIn = $derived(ticket !== null && ticket.checkedInAt !== null)

  const onCheckIn = async (): Promise<void> => {
    if (stored === null || ticket === null) return
    checkInBusy = true
    try {
      const r = await checkIn(stored.ticketId)
      if (!r.ok) {
        error = {
          tag: r.error._tag,
          code: r.error.code,
          message: errorMessage(r.error._tag),
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
          message: errorMessage(r.error._tag),
        }
        return
      }
      const t = r.value.ticket
      ticket = t
      error = null
      writeTicketCache({
        ticketId: t.id,
        nameKana: t.nameKana,
        phoneLast4: t.phoneLast4,
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
        nudgeCount: ("nudgeCount" in t ? t.nudgeCount : null) ?? 0,
        displaySeq: t.displaySeq,
      })
      // Terminal observation — keep the view rendered so the
      // customer sees "対応完了" / "キャンセル済", but release the
      // cache so the next mount falls through to /recover. The
      // server reaps push_subscriptions on its end (ADR-0074); we
      // also unsubscribe on the client so a future visitor on the
      // same device does not inherit a stale subscription.
      if (isTerminalState(t.state)) {
        purgeTicketCache()
        clearAlertMemory()
        // Abort any pending subscribeToPush so we don't race the
        // unsubscribe with a late register.
        subscribeAbort.abort()
        void unsubscribeFromPush(t.id, stored)
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

  const stateLabel = $derived.by(() => {
    if (ticket === null) return ""
    switch (ticket.state) {
      case "Waiting":
        return m.ticket_state_waiting()
      case "Called":
        return m.ticket_state_called()
      case "Overdue": {
        // M4: surface the nudge count so the customer perceives "more
        // urgent on the second / third ping". We do NOT expose
        // MAX_NUDGES to the client (operational info).
        const n = ticket.nudgeCount ?? 0
        return n > 0
          ? m.ticket_state_overdue_with_nudge({ count: String(n) })
          : m.ticket_state_overdue()
      }
      case "Served":
        return m.ticket_state_served()
      case "NoShow":
        return m.ticket_state_noshow()
      case "Cancelled":
        return ticket.reason === "appointment_lapsed"
          ? m.ticket_state_cancelled_appointment_lapsed()
          : m.ticket_state_cancelled()
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
      // Pull the latest projection so the appointment Card / feed
      // reflect the new slot's occupancy without waiting for the
      // next WS broadcast.
      if (stored !== null) await refresh(stored)
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
    // ADR-0073 — best-effort Web Push subscription so the customer
    // hears the Overdue nudge with the tab closed. Silent failure
    // is fine; the WS broadcast still fires when the tab is open.
    // AbortController guards against the case where the page is
    // destroyed (onDestroy → controller.abort()) while subscribe is
    // mid-flight: without the abort signal a late-resolving
    // subscribe could write a row that the unmount unsubscribe
    // already skipped.
    {
      const pub = vapidPublicKey()
      if (pub !== null && ticket !== null && !isTerminalState(ticket.state)) {
        void subscribeToPush({
          ticketId: ticket.id,
          handle: stored,
          vapidPublicKey: pub,
          signal: subscribeAbort.signal,
        })
      }
    }
    // ADR-0073 §subscriptionchange — the SW posts `push:resubscribe`
    // when the push service rotates keys. Re-run the subscribe flow;
    // pushSubscribe's reconcile branch will DELETE the stale endpoint
    // before registering the fresh one.
    //
    // `{ signal: subscribeAbort.signal }` ties the listener lifecycle
    // to onDestroy → controller.abort(); without it every SPA mount
    // would stack another listener and one push event would fan out
    // into N subscribe calls.
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener(
        "message",
        (event) => {
          const data = event.data as { type?: string } | null
          if (data?.type !== "push:resubscribe") return
          const pub = vapidPublicKey()
          if (pub === null || ticket === null || stored === null) return
          if (isTerminalState(ticket.state)) return
          void subscribeToPush({
            ticketId: ticket.id,
            handle: stored,
            vapidPublicKey: pub,
            signal: subscribeAbort.signal,
          })
        },
        { signal: subscribeAbort.signal },
      )
    }
    feed = connectQueueFeed({
      onProjection: (parsed) => {
        snapshot = parsed as ShopState
        // ADR-0061 — the WS broadcasts the public projection only.
        // The customer's own state (Waiting → Called → Overdue →
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
    subscribeAbort.abort()
  })
</script>

<svelte:head>
  <title>{m.ticket_title()}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<section class="ticket-page">
  {#if error !== null}
    <ErrorCard
      tag={error.tag}
      code={error.code}
      message={error.message}
      retryLabel={m.ticket_retry_label()}
      onRetry={() => stored !== null && refresh(stored)}
    />
  {/if}

  {#if ticket !== null}
    <div class="numeral-hero" data-state={ticket.state}>
      <span class="state-tag">{stateLabel}</span>
      <span class="numeral-label">{m.ticket_numeral_label()}</span>
      <span class="numeral">{ticket.displaySeq}</span>
    </div>

    <div class="stepper-row">
      <StateStepper ticket={ticket} variant="full" />
    </div>

    {#if isReservation && minutesUntilAppointment !== null}
      <Card>
        <div class="appointment">
          <span class="appointment-label">{m.ticket_appointment_label()}</span>
          <span class="appointment-time">{ticket.appointmentAt?.slice(11, 16) ?? ""}</span>
          {#if alreadyCheckedIn}
            <span class="appointment-badge badge-arrived">{m.ticket_appointment_arrived()}</span>
          {:else if minutesUntilAppointment > 0}
            <span class="appointment-countdown">
              {m.ticket_appointment_countdown({ minutes: String(minutesUntilAppointment) })}
            </span>
          {:else}
            <span class="appointment-countdown overdue">{m.ticket_appointment_overdue()}</span>
          {/if}
          {#if checkInAvailable && !alreadyCheckedIn}
            <Button
              size="md"
              fullWidth
              disabled={checkInBusy}
              onclick={onCheckIn}
            >
              {checkInBusy ? m.common_submit_busy() : m.ticket_checkin_button()}
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
                {m.ticket_reschedule_button()}
              </Button>
              <Help text={helpText("reschedule")} label={m.ticket_reschedule_help_label()} />
            </div>
          {/if}
        </div>
      </Card>
    {:else if ticket.state === "Waiting" && positionInfo !== null}
      <Card>
        <p class="position">
          {m.ticket_position_template({ count: String(positionInfo) })}
        </p>
      </Card>
    {/if}

    {#if ticket.state === "Waiting" && notificationState === "default"}
      <Card>
        <div class="notif-opt-in">
          <p class="notif-msg">
            {m.notify_permission_question()}
            <Help text={helpText("notifyPermission")} label={m.ticket_notify_help_label()} />
          </p>
          <Button variant="secondary" size="md" onclick={onRequestNotification}>
            {m.ticket_notify_button()}
          </Button>
        </div>
      </Card>
    {/if}

    {#if feedState === "reconnecting"}
      <p class="banner" role="status" aria-live="polite">{loadingState("revalidate")}</p>
    {/if}

    {#if qrDataUrl !== null}
      <Card>
        <div class="qr">
          <img src={qrDataUrl} alt={m.ticket_qr_alt()} width="240" height="240" />
          <div class="qr-help">
            <p>{m.ticket_qr_label()}</p>
            <Button variant="secondary" size="md" onclick={onCopyUrl}>
              {m.ticket_qr_copy_button()}
            </Button>
          </div>
        </div>
      </Card>
    {/if}

    {#if ticket.state === "Waiting" || ticket.state === "Called" || ticket.state === "Overdue"}
      {#if ticket.state === "Overdue"}
        <p class="overdue-note" role="status">{m.ticket_overdue_note()}</p>
      {/if}
      <div class="actions">
        <Button
          variant="ghost"
          size="md"
          disabled={feedState !== "open"}
          onclick={() => (cancelDialogOpen = true)}
        >
          {m.common_cancel()}
        </Button>
      </div>
    {/if}
  {:else if error === null}
    <p class="loading">{loadingState("ticket")}</p>
  {/if}

  <Dialog
    bind:open={cancelDialogOpen}
    title={m.ticket_cancel_dialog_title()}
    onClose={() => (cancelDialogOpen = false)}
  >
    <p>{m.confirm_cancel_body()}</p>
    <p class="dialog-hint">{m.ticket_cancel_reason_hint()}</p>
    <textarea
      bind:value={cancelReason}
      rows="2"
      placeholder={m.ticket_cancel_reason_placeholder()}
    ></textarea>
    {#snippet actions()}
      <Button variant="ghost" onclick={() => (cancelDialogOpen = false)}>{m.common_back()}</Button>
      <Button variant="destructive" disabled={cancelBusy} onclick={onCancelConfirm}>
        {cancelBusy ? m.common_submit_busy() : m.common_cancel()}
      </Button>
    {/snippet}
  </Dialog>

  <Dialog
    bind:open={rescheduleDialogOpen}
    title={m.ticket_reschedule_dialog_title()}
    onClose={() => (rescheduleDialogOpen = false)}
  >
    {#if ticket !== null && ticket.appointmentAt !== null && ticket.appointmentAt !== undefined}
      <p class="reschedule-current">
        {m.ticket_reschedule_current_label()}
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
      <Button variant="ghost" onclick={() => (rescheduleDialogOpen = false)}>{m.common_back()}</Button>
      <Button
        variant="primary"
        disabled={rescheduleBusy ||
          rescheduleNewISO === null ||
          rescheduleNewISO === ticket?.appointmentAt}
        onclick={onRescheduleConfirm}
      >
        {rescheduleBusy ? m.common_submit_busy() : m.ticket_reschedule_confirm()}
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
  .numeral-hero[data-state="Called"] {
    background: oklch(95% 0.07 65);
    border-color: var(--color-state-called);
  }
  .numeral-hero[data-state="Overdue"] {
    background: oklch(92% 0.13 30 / 60%);
    border-color: oklch(70% 0.18 30);
  }
  .numeral-hero[data-state="Served"] {
    background: oklch(95% 0.07 145);
    border-color: var(--color-state-serving);
  }
  .overdue-note {
    background: oklch(95% 0.07 30 / 50%);
    color: oklch(35% 0.18 30);
    border-left: 3px solid oklch(70% 0.18 30);
    padding: var(--space-3) var(--space-4);
    margin: var(--space-3) 0;
    font: var(--text-body-sm);
  }
  .numeral-hero[data-state="Cancelled"],
  .numeral-hero[data-state="NoShow"] {
    background: var(--color-bg-subtle);
    color: var(--color-fg-muted);
  }
  .numeral-label {
    font: var(--text-label-sm);
    color: var(--color-fg-muted);
    margin-top: var(--space-1);
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
  .stepper-row {
    margin-block: var(--space-6);
    padding-inline: var(--space-2);
  }
  .position {
    text-align: center;
    margin: 0;
    font: var(--text-body-md);
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
  .dialog-hint {
    margin: var(--space-3) 0 var(--space-2);
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
  }
</style>
