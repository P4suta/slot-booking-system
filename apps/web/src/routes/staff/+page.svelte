<script lang="ts">
  import { onDestroy, onMount } from "svelte"
  import {
    type ApiResult,
    callSpecific,
    connectQueueFeed,
    markNoShow,
    markServed,
    type QueueFeedHandle,
    type QueueFeedState,
    recall,
    staffCancel,
    staffShopState,
    type Ticket,
  } from "$lib/api.js"
  import Button from "$lib/components/Button.svelte"
  import Card from "$lib/components/Card.svelte"
  import StateStepper from "$lib/components/StateStepper.svelte"
  import Toast from "$lib/components/Toast.svelte"
  import {
    emptyState,
    errorMessage,
    feedStatusContextLabel,
    feedStatusLabel,
    m,
  } from "$lib/messages.js"
  import {
    clearStaffSession,
    persistStaffSession,
    readStoredSession,
    type StaffSession,
  } from "$lib/staffSession.js"

  type ToastVariant = "info" | "success" | "warning" | "danger"
  type ToastState = {
    message: string
    variant?: ToastVariant
    undoLabel?: string
    onUndo?: () => void
  }

  /* ---------- state ---------- */
  // Two distinct concerns, deliberately kept apart so a future
  // refactor cannot collapse them:
  //
  //   - `formToken` mirrors the login form input via `bind:value`.
  //     It exists only while the operator is typing. Setting it is
  //     not a session-level event.
  //   - `session` is the credentialled-or-not flag managed by
  //     `lib/staffSession.ts`. It transitions ONLY through
  //     `persistStaffSession()` / `clearStaffSession()` — typing
  //     into the form cannot reach it. SSR has no localStorage
  //     access so the initial value is always `anonymous`; the
  //     `onMount` bootstrap is what picks up a prior session.
  let formToken = $state("")
  let session = $state<StaffSession>({ kind: "anonymous" })
  const authenticated = $derived(session.kind === "authenticated")
  // Helper: read the current token AT CALL TIME from session. Used
  // instead of a `$derived` to avoid any read-ordering pitfall
  // between writes to `session` and immediate REST calls. If the
  // session is anonymous the helper returns "" — callers MUST treat
  // an empty token as "don't call the staff API" because the
  // `/api/v1/queue` route silently degrades to the anonymous
  // projection (no `terminal`, no PII on tickets) when the header
  // is missing, which would deserialize into the staff-shaped type
  // as `undefined` fields and crash the card render.
  const currentToken = (): string =>
    session.kind === "authenticated" ? session.token : ""
  let waiting = $state<ReadonlyArray<Ticket>>([])
  let calling = $state<ReadonlyArray<Ticket>>([])
  let overdueList = $state<ReadonlyArray<Ticket>>([])
  let done = $state<ReadonlyArray<Ticket>>([])
  let busy = $state(false)
  let error = $state<string | null>(null)
  let feedState: QueueFeedState = $state("connecting")
  let feed: QueueFeedHandle | undefined
  let prevWaitingCount: number | null = null
  let search = $state("")
  let expanded = $state<Set<string>>(new Set())
  let toast = $state<ToastState | null>(null)
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

  // Render-time canary: the API type pins nameKana/phoneLast4 as
  // non-empty strings (the server's `IssueTicketBodySchema` rejects
  // empty + missing inputs, and `TicketSchema` does the same on
  // every read), so an empty value here means a code path elsewhere
  // bypassed the boundary. We surface it loudly rather than silently
  // rendering a blank field — a silent blank is the worst outcome:
  // the operator sees the same chrome as a valid card and never
  // learns there is a data-quality bug to investigate.
  const isPiiMissing = (value: string): boolean => value.length === 0

  // Staff-facing state names. The customer-facing /ticket page uses
  // friendlier phrasings ("お待ちください" / "応答をお願いします")
  // because those are sentences directed AT the customer; here they
  // are status indicators read BY the operator, so we stick to short
  // labels that match the state-tally chips for visual consistency.
  const stateLabel = (state: Ticket["state"]): string => {
    switch (state) {
      case "Waiting":
        return m.staff_card_state_waiting()
      case "Called":
        return m.staff_card_state_called()
      case "Overdue":
        return m.staff_card_state_overdue()
      case "Served":
        return m.staff_card_state_served()
      case "NoShow":
        return m.staff_card_state_noshow()
      case "Cancelled":
        return m.staff_card_state_cancelled()
    }
  }

  /* ---------- derived ---------- */
  // Active list — staff sees one stream of tickets that need attention,
  // ordered by urgency: Called (currently being attended) → Overdue
  // (needs an answer) → Waiting (head-of-chain). Server gives them as
  // three arrays; we concatenate via Array#concat (defensive against a
  // historical render mismatch where the spread `[...callerProxy]`
  // failed to iterate the reactive proxy in some HMR transitions).
  // Each slice is already sorted per ADR-0062/0065/0067 within itself.
  const filteredActive = $derived.by(() => {
    let list: ReadonlyArray<Ticket> = ([] as ReadonlyArray<Ticket>).concat(
      calling,
      overdueList,
      waiting,
    )
    const q = search.trim().toLowerCase()
    if (q.length > 0) {
      list = list.filter(
        (t) => t.nameKana.toLowerCase().includes(q) || t.phoneLast4 === q,
      )
    }
    return list
  })
  const totalActive = $derived(calling.length + overdueList.length + waiting.length)

  /* ---------- refresh ---------- */
  // Response-shape guard: the staff-only path returns a `terminal`
  // field; the anonymous fallback does not. If the field is absent
  // it means the request fired without a valid token (the server
  // happily degrades to the anonymous projection rather than 4xx-ing
  // on a missing header), so we treat it as an auth failure rather
  // than blindly assigning `undefined` arrays into the staff-shaped
  // state — which used to crash the card render via
  // `t.nameKana.length` on `nameKana: undefined`.
  const isStaffResponse = (
    value: unknown,
  ): value is { readonly terminal: readonly Ticket[] } =>
    typeof value === "object" &&
    value !== null &&
    "terminal" in value &&
    Array.isArray((value as { terminal: unknown }).terminal)

  const refresh = async (): Promise<void> => {
    const token = currentToken()
    if (token.length === 0) {
      // No credential to refresh against — let the bootstrap /
      // onLogin path own the first call. Bailing here avoids the
      // anonymous-degrade pitfall described above.
      return
    }
    try {
      const r = await staffShopState(token)
      if (!r.ok) {
        error = m.staff_refresh_error_template({ reason: errorMessage(r.error._tag) })
        if (r.error._tag === "MissingStaffCapability") onLogout()
        return
      }
      if (!isStaffResponse(r.value)) {
        // The server returned the anonymous projection. The stored
        // token is no longer accepted (rotated secret, etc.) — force
        // a logout so the operator sees the login form rather than
        // a half-broken dashboard.
        error = m.staff_session_expired()
        onLogout()
        return
      }
      const nextCount = r.value.waitingCount
      if (prevWaitingCount !== null && nextCount > prevWaitingCount) {
        notifyArrival(nextCount - prevWaitingCount)
      }
      prevWaitingCount = nextCount
      waiting = r.value.waitingPreview
      calling = r.value.calling
      overdueList = r.value.overdue
      done = r.value.terminal
      error = null
    } catch (e) {
      error = m.staff_refresh_error_template({
        reason: e instanceof Error ? e.message : m.staff_error_network(),
      })
    }
  }

  /* ---------- arrival cue (always on; the staff hears a soft chime
   * + receives a desktop notification when a new ticket arrives in
   * the background). The cue is for the operator at the desk, not for
   * the customer, so an accidental top-bar tap should not silence it. */
  const notifyArrival = (delta: number): void => {
    const body =
      delta === 1
        ? m.staff_notify_arrival_one()
        : m.staff_notify_arrival_multi({ count: String(delta) })
    if (typeof window !== "undefined") {
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
      new Notification(m.staff_notify_title(), { body, tag: "queue-new-arrival" })
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
        const msg = m.staff_action_error_template({
          label,
          reason: errorMessage(r.error._tag),
        })
        error = msg
        if (r.error._tag === "MissingStaffCapability") {
          onLogout()
          return
        }
        showToast(msg, "danger")
        return
      }
      onSuccess?.(r.value)
    } catch (e) {
      error = m.staff_action_error_template({
        label,
        reason: e instanceof Error ? e.message : m.staff_error_network(),
      })
    } finally {
      busy = false
    }
    void refresh()
  }

  const showToast = (
    message: string,
    variant?: ToastVariant,
    undoLabel?: string,
    onUndo?: () => void,
  ): void => {
    toast = { message, variant, undoLabel, onUndo }
  }

  /* ---------- auth ---------- */
  // verify-before-flip: probe the staff endpoint with the typed
  // token before persisting. An invalid token returns a domain
  // error which we surface inline — the dashboard never renders for
  // a credential the server would have rejected on the next call.
  const onLogin = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    const candidate = formToken.trim()
    if (candidate.length === 0) {
      error = m.staff_login_token_required()
      return
    }
    busy = true
    error = null
    try {
      const probe = await staffShopState(candidate)
      if (!probe.ok) {
        error = m.staff_login_error_template({ reason: errorMessage(probe.error._tag) })
        return
      }
      // The server silently degrades to the anonymous projection when
      // `x-staff-token` is missing or wrong (200 + `ShopState` shape,
      // no `terminal` field). A probe that came back without
      // `terminal` therefore means the token was rejected, not that
      // login succeeded. Surface as an inline error rather than
      // persisting the credential — otherwise the page enters a
      // "persist → refresh → shape-guard → logout" loop that looks
      // to the operator like the login button reloaded the page.
      if (!isStaffResponse(probe.value)) {
        error = m.staff_login_error_invalid_token()
        return
      }
      session = persistStaffSession(candidate)
      formToken = ""
      ensureNotificationPermission()
      await startLiveFeed()
    } catch (e) {
      error = m.staff_login_error_template({
        reason: e instanceof Error ? e.message : m.staff_error_network(),
      })
    } finally {
      busy = false
    }
  }

  const onLogout = (): void => {
    session = clearStaffSession()
    formToken = ""
    feed?.close()
    feed = undefined
    waiting = []
    calling = []
    overdueList = []
    done = []
    expanded = new Set()
    prevWaitingCount = null
    error = null
  }

  /* ---------- operator actions ---------- */
  const onCallSpecific = (ticketId: string): Promise<void> =>
    runAction(
      m.staff_runaction_label_call(),
      () => callSpecific(currentToken(), ticketId),
      (v) => {
        const t = (v as { ticket: Ticket }).ticket
        showToast(
          m.staff_toast_called_template({ displaySeq: String(t.displaySeq) }),
          "info",
          m.staff_toast_undo_label(),
          () => onRecallTicket(t.id),
        )
      },
    )

  const onMarkServed = (ticketId: string): Promise<void> =>
    runAction(
      m.staff_runaction_label_serve(),
      () => markServed(currentToken(), ticketId),
      () => showToast(m.staff_toast_served(), "success"),
    )

  const onMarkNoShow = (ticketId: string): Promise<void> =>
    runAction(
      m.staff_runaction_label_noshow(),
      () => markNoShow(currentToken(), ticketId),
      () => showToast(m.staff_toast_noshow(), "warning"),
    )

  const onRecallTicket = (ticketId: string): Promise<void> =>
    runAction(
      m.staff_runaction_label_recall(),
      () => recall(currentToken(), ticketId),
      () => showToast(m.staff_toast_recalled(), "info"),
    )

  const onStaffCancel = (ticketId: string): Promise<void> =>
    runAction(
      m.staff_runaction_label_cancel(),
      () => staffCancel(currentToken(), ticketId, "staff-cancel"),
      () => showToast(m.staff_toast_cancelled(), "warning"),
    )

  /* ---------- expansion ---------- */
  const toggleExpand = (id: string): void => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expanded = next
  }

  /* ---------- lifecycle ---------- */
  onMount(async () => {
    // Bootstrap: SSR cannot read localStorage, so the page always
    // mounts with `session = anonymous`. Pick up a prior credential
    // here. The page state below the {#if authenticated} branch
    // never sees a transient "anonymous → authenticated" flicker
    // because the re-render happens before the user can interact.
    const stored = readStoredSession()
    if (stored.kind === "authenticated") {
      session = stored
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
  <title>{m.staff_title()}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

{#if !authenticated}
  <section class="login">
    <Card>
      <h1>{m.staff_login_h1()}</h1>
      <form onsubmit={onLogin}>
        <label class="field">
          <span class="label">{m.staff_login_token_label()}</span>
          <input
            type="password"
            bind:value={formToken}
            required
            autocomplete="off"
            disabled={busy}
          />
        </label>
        {#if error !== null}
          <p class="login-error" role="alert">{error}</p>
        {/if}
        <Button type="submit" size="lg" fullWidth disabled={busy}>
          {busy ? m.staff_login_submit_busy() : m.staff_login_submit()}
        </Button>
      </form>
    </Card>
  </section>
{:else}
  <!-- page header: full-bleed, sticky, tinted so the staff knows at a
       glance which screen they are on (this is the operator side, not
       the customer landing). Identifier row shows 店舗管理 + system
       subtitle, action row carries search + logout. -->
  <header class="staff-header">
    <div class="staff-header-inner">
      <div class="staff-header-identity-row">
        <div class="staff-header-identity">
          <span class="staff-header-screen">{m.staff_header_screen()}</span>
          <span class="staff-header-subtitle">{m.staff_header_subtitle()}</span>
        </div>
        <span
          class="feed-status"
          data-state={feedState}
          role="status"
          aria-live="polite"
        >
          <span class="feed-status-dot" aria-hidden="true"></span>
          <span class="feed-status-text">
            {feedStatusContextLabel()}: {feedStatusLabel(feedState)}
          </span>
        </span>
      </div>
      <div class="staff-header-action-row">
        <input
          type="search"
          bind:value={search}
          placeholder={m.staff_search_placeholder()}
          class="search"
          aria-label={m.staff_search_aria_label()}
        />
        <Button variant="ghost" size="md" onclick={onLogout}>
          {m.staff_logout_button()}
        </Button>
      </div>
    </div>
  </header>

  <div class="staff">
    {#if error !== null}
      <p class="error" role="alert">{error}</p>
    {/if}

    <!-- main: one list of all active tickets, ordered Called → Overdue
         → Waiting (each slice already sorted per ADR-0062/0065/0067). -->
    <section class="active">
      <header class="section-header">
        <h2>
          {m.staff_section_active_title({
            filtered: String(filteredActive.length),
            total: String(totalActive),
          })}
        </h2>
      </header>

      <div class="cards">
        {#each filteredActive as t (t.id)}
          <Card>
            <article
              class="ticket"
              data-state={t.state}
              data-expanded={expanded.has(t.id) ? "true" : undefined}
            >
              <button
                type="button"
                class="ticket-summary"
                aria-expanded={expanded.has(t.id)}
                aria-label={m.staff_card_actions_aria_label()}
                onclick={() => toggleExpand(t.id)}
              >
                <div class="ticket-headline">
                  <span class="numeral">{t.displaySeq}</span>
                  <span class="name">
                    {#if isPiiMissing(t.nameKana)}
                      <span class="value-missing" title={m.staff_pii_missing_name_tooltip()}>
                        {m.staff_pii_missing_label()}
                      </span>
                    {:else}
                      {t.nameKana}
                    {/if}
                  </span>
                  <span class="phone">
                    {#if isPiiMissing(t.phoneLast4)}
                      <span class="value-missing" title={m.staff_pii_missing_phone_tooltip()}>
                        {m.staff_pii_missing_label()}
                      </span>
                    {:else}
                      {t.phoneLast4}
                    {/if}
                  </span>
                </div>
                {#if t.freeText !== null && t.freeText !== undefined && t.freeText.length > 0}
                  <p class="freeText">{t.freeText}</p>
                {/if}
                <div class="ticket-meta">
                  {#if t.appointmentAt !== null}
                    <span class="slot-chip" data-time-state={slotChipState(t.appointmentAt)}>
                      {m.staff_card_appointment_prefix({ time: t.appointmentAt.slice(11, 16) })}
                    </span>
                  {/if}
                  <span class="state-current-label state-{t.state}">{stateLabel(t.state)}</span>
                </div>
                <div class="ticket-progress">
                  <StateStepper ticket={t} variant="compact" />
                </div>
              </button>
              {#if expanded.has(t.id)}
                <div class="ticket-actions">
                  {#if t.state === "Waiting"}
                    <Button
                      variant="primary"
                      size="md"
                      disabled={busy}
                      onclick={() => onCallSpecific(t.id)}
                    >
                      {m.staff_action_call()}
                    </Button>
                    <Button
                      variant="ghost"
                      size="md"
                      disabled={busy}
                      onclick={() => onStaffCancel(t.id)}
                    >
                      {m.common_cancel()}
                    </Button>
                  {:else if t.state === "Called" || t.state === "Overdue"}
                    <Button
                      variant="primary"
                      size="md"
                      disabled={busy}
                      onclick={() => onMarkServed(t.id)}
                    >
                      {m.staff_action_serve()}
                    </Button>
                    <Button
                      variant="ghost"
                      size="md"
                      disabled={busy}
                      onclick={() => onMarkNoShow(t.id)}
                    >
                      {m.staff_action_noshow()}
                    </Button>
                    <Button
                      variant="ghost"
                      size="md"
                      disabled={busy}
                      onclick={() => onRecallTicket(t.id)}
                    >
                      {m.staff_action_recall()}
                    </Button>
                    <Button
                      variant="ghost"
                      size="md"
                      disabled={busy}
                      onclick={() => onStaffCancel(t.id)}
                    >
                      {m.common_cancel()}
                    </Button>
                  {/if}
                </div>
              {/if}
            </article>
          </Card>
        {/each}
        {#if filteredActive.length === 0}
          <p class="empty">
            {totalActive === 0
              ? m.staff_empty_active()
              : m.staff_empty_filtered()}
          </p>
        {/if}
      </div>
    </section>

    <!-- history: read-only recent terminal tickets, muted, no actions -->
    <section class="history">
      <header class="section-header">
        <h2>{m.staff_section_history_title({ count: String(done.length) })}</h2>
      </header>
      <div class="cards">
        {#each done.slice(0, 8) as t (t.id)}
          <Card>
            <article class="ticket muted" data-state={t.state}>
              <div class="ticket-headline">
                <span class="numeral">{t.displaySeq}</span>
                <span class="name">
                  {#if isPiiMissing(t.nameKana)}
                    <span class="value-missing" title={m.staff_pii_missing_name_tooltip()}>
                      {m.staff_pii_missing_label()}
                    </span>
                  {:else}
                    {t.nameKana}
                  {/if}
                </span>
                <span class="phone">
                  {#if isPiiMissing(t.phoneLast4)}
                    <span class="value-missing" title={m.staff_pii_missing_phone_tooltip()}>
                      {m.staff_pii_missing_label()}
                    </span>
                  {:else}
                    {t.phoneLast4}
                  {/if}
                </span>
              </div>
              <div class="ticket-meta">
                {#if t.appointmentAt !== null}
                  <span class="slot-chip" data-time-state={slotChipState(t.appointmentAt)}>
                    {m.staff_card_appointment_prefix({ time: t.appointmentAt.slice(11, 16) })}
                  </span>
                {/if}
                <span class="state-current-label state-{t.state}">{stateLabel(t.state)}</span>
              </div>
              <div class="ticket-progress">
                <StateStepper ticket={t} variant="compact" />
              </div>
            </article>
          </Card>
        {/each}
        {#if done.length === 0}
          <p class="empty">{emptyState("terminal")}</p>
        {/if}
      </div>
    </section>

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
  .login-error {
    background: oklch(95% 0.05 25);
    color: var(--color-state-danger);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    margin: 0 0 var(--space-4);
    font: var(--text-body-sm);
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
    max-width: 56rem;
    margin: 0 auto;
  }
  /* full-bleed sticky page header — gives the staff a constant
   * "you are on the operator screen" cue, even after they scroll the
   * card list. Tinted background distinguishes it from the customer-
   * facing pages, which use the bare layout chrome. */
  .staff-header {
    position: sticky;
    top: 0;
    z-index: 50;
    background: oklch(95% 0.025 250 / 92%);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--color-border-subtle);
    box-shadow: var(--shadow-sm);
  }
  .staff-header-inner {
    max-width: 56rem;
    margin: 0 auto;
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .staff-header-identity-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .staff-header-identity {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .staff-header-screen {
    font: var(--text-numeral-md);
    color: var(--color-fg-primary);
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .staff-header-subtitle {
    font: var(--text-label-sm);
    color: var(--color-fg-muted);
  }
  .staff-header-action-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .feed-status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-pill);
    background: var(--color-bg-subtle);
    border: 1px solid var(--color-border-subtle);
    font: var(--text-label-sm);
    color: var(--color-fg-secondary);
  }
  .feed-status-dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: var(--radius-pill);
    background: var(--color-fg-muted);
    flex-shrink: 0;
  }
  .feed-status[data-state="open"] {
    background: oklch(95% 0.07 145 / 50%);
    border-color: var(--color-state-serving);
    color: oklch(35% 0.13 145);
  }
  .feed-status[data-state="open"] .feed-status-dot {
    background: var(--color-state-serving);
  }
  .feed-status[data-state="reconnecting"],
  .feed-status[data-state="connecting"] {
    background: oklch(95% 0.07 65 / 50%);
    border-color: var(--color-state-called);
    color: oklch(40% 0.13 65);
  }
  .feed-status[data-state="reconnecting"] .feed-status-dot,
  .feed-status[data-state="connecting"] .feed-status-dot {
    background: var(--color-state-called);
  }
  .feed-status[data-state="closed"] {
    background: oklch(95% 0.05 25 / 50%);
    border-color: var(--color-state-danger);
    color: var(--color-state-danger);
  }
  .feed-status[data-state="closed"] .feed-status-dot {
    background: var(--color-state-danger);
  }
  .search {
    flex: 1;
    min-width: 14rem;
  }
  .error {
    background: oklch(95% 0.05 25);
    color: var(--color-state-danger);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    margin: 0 0 var(--space-4);
    font: var(--text-body-sm);
  }
  .active,
  .history {
    margin-bottom: var(--space-8);
  }
  .section-header {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .section-header h2 {
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
    gap: var(--space-3);
  }
  .ticket[data-state="Called"] {
    border-left: 4px solid var(--color-state-called);
    padding-left: var(--space-3);
  }
  .ticket[data-state="Overdue"] {
    border-left: 4px solid oklch(70% 0.18 30);
    padding-left: var(--space-3);
  }
  .ticket-summary {
    appearance: none;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    text-align: left;
    width: 100%;
    cursor: pointer;
    color: inherit;
    font: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .ticket-summary:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
    border-radius: var(--radius-md);
  }
  /* Card head: numeral + name + phone を 1 行で大きく。
   * 整理券番号は最大文字、 名前と末尾4桁はその右に並べて
   * 操作者が 1m 離れた position からも読める情報密度に。 */
  .ticket-headline {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: baseline;
    gap: var(--space-4);
  }
  .ticket-headline .numeral {
    font: var(--text-numeral-md);
    font-variant-numeric: tabular-nums;
    color: var(--color-fg-primary);
    line-height: 1;
  }
  .ticket-headline .name {
    font: var(--text-body-lg);
    color: var(--color-fg-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .ticket-headline .phone {
    font: var(--text-mono-md);
    color: var(--color-fg-primary);
    font-variant-numeric: tabular-nums;
  }
  .ticket-meta {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .ticket-progress {
    margin-top: var(--space-1);
  }
  .state-current-label {
    font: var(--text-label-sm);
    color: var(--color-fg-secondary);
    font-weight: 600;
  }
  .state-current-label.state-Called {
    color: oklch(40% 0.13 65);
  }
  .state-current-label.state-Overdue {
    color: oklch(35% 0.18 30);
  }
  .state-current-label.state-Served {
    color: oklch(35% 0.13 145);
  }
  /* Waiting / NoShow / Cancelled の現在地ラベルは muted のまま。
   * stepper 内の dot / terminal glyph 色で進行は十分伝わるので、
   * 文字色で更に主張すると history 列の muted 感と競合する。 */
  .slot-chip {
    font: var(--text-mono-sm);
    color: var(--color-fg-secondary);
    background: var(--color-bg-subtle);
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
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
  /* Canary marker — surfaces when a PII field is empty even though
   * the API type pins it as non-empty. If this ever shows up on
   * screen, a code path bypassed `IssueTicketBodySchema` /
   * `TicketSchema`. Styled loud so the staff (and reviewing devs)
   * cannot miss it. */
  .value-missing {
    color: var(--color-state-danger);
    background: oklch(95% 0.05 25 / 60%);
    border: 1px dashed var(--color-state-danger);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-2);
    font-style: italic;
    font-weight: 600;
  }
  .freeText {
    margin: 0;
    color: var(--color-fg-primary);
    font: var(--text-body-sm);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ticket-actions {
    border-top: 1px solid var(--color-border-subtle);
    padding-top: var(--space-3);
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
    opacity: 0.65;
  }
  .toast-host {
    position: fixed;
    bottom: var(--space-6);
    right: var(--space-6);
    z-index: 1000;
  }
</style>
