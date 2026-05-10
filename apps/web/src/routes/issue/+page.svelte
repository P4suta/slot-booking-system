<script lang="ts">
  import { goto } from "$app/navigation"
  import { onMount } from "svelte"
  import { issueTicket, listSlots, type SlotEntry } from "$lib/api.js"
  import Button from "$lib/components/Button.svelte"
  import ErrorCard from "$lib/components/ErrorCard.svelte"
  import PhoneOtpInput from "$lib/components/PhoneOtpInput.svelte"
  import { toKatakana } from "$lib/kana.js"
  import { readTicketCache, writeTicketCache } from "$lib/ticketCache.js"

  let nameKana = $state("")
  let phoneLast4 = $state("")
  let freeText = $state("")
  let busy = $state(false)
  let error: { tag: string; code: string; message: string } | null = $state(null)
  let reservationOpen = $state(false)
  let slotsLoading = $state(false)
  let slots: readonly SlotEntry[] = $state([])
  let selectedDate = $state(todayIso())
  let selectedBucketId: number | null = $state(null)
  // ADR-0069 §Stage 8 — same-handle re-issue would just merge into
  // the existing ticket and goto /ticket anyway; pre-empt the
  // round-trip by bouncing to /ticket the moment we see a cache hit.
  let booting = $state(true)

  onMount(async () => {
    const cached = readTicketCache()
    if (cached !== null) {
      await goto(`/ticket?id=${encodeURIComponent(cached.ticketId)}`)
      return
    }
    booting = false
  })

  const GRANULARITY = 30 as const

  function todayIso(): string {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }

  function dateOffsetIso(days: number): string {
    const d = new Date()
    d.setDate(d.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }

  const dateTabs = [
    { iso: dateOffsetIso(0), label: "今日" },
    { iso: dateOffsetIso(1), label: "明日" },
    { iso: dateOffsetIso(2), label: "明後日" },
  ]

  // ひらがな入力を即座にカタカナへ昇格 (UX 配慮)。
  const onNameInput = (event: Event): void => {
    const el = event.currentTarget as HTMLInputElement
    nameKana = toKatakana(el.value)
  }

  const ensureSlotsLoaded = async (): Promise<void> => {
    if (slots.length > 0 || slotsLoading) return
    slotsLoading = true
    try {
      const result = await listSlots({
        from: dateTabs[0].iso,
        to: dateTabs[2].iso,
        granularity: GRANULARITY,
      })
      if (result.ok) slots = result.value.slots
    } finally {
      slotsLoading = false
    }
  }

  const onReservationToggle = (event: Event): void => {
    const detail = event.currentTarget as HTMLDetailsElement
    reservationOpen = detail.open
    if (detail.open) void ensureSlotsLoaded()
  }

  const slotInstantOf = (date: string, bucketId: number): string => {
    const minutes = bucketId * GRANULARITY
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0")
    const mm = String(minutes % 60).padStart(2, "0")
    return `${date}T${hh}:${mm}:00.000Z`
  }

  const submitWalkIn = async (): Promise<void> => {
    error = null
    busy = true
    try {
      const result = await issueTicket({
        nameKana,
        phoneLast4,
        freeText: freeText.length === 0 ? null : freeText,
      })
      await handleResult(result)
    } catch (e) {
      reportNetworkError(e)
    } finally {
      busy = false
    }
  }

  const submitReservation = async (): Promise<void> => {
    if (selectedBucketId === null) {
      error = {
        tag: "InvalidBody",
        code: "E_VAL_BODY",
        message: "時間枠を選択してください",
      }
      return
    }
    error = null
    busy = true
    try {
      const result = await issueTicket({
        nameKana,
        phoneLast4,
        freeText: freeText.length === 0 ? null : freeText,
        lane: "reservation",
        appointmentAt: slotInstantOf(selectedDate, selectedBucketId),
      })
      await handleResult(result)
    } catch (e) {
      reportNetworkError(e)
    } finally {
      busy = false
    }
  }

  const handleResult = async (
    result: Awaited<ReturnType<typeof issueTicket>>,
  ): Promise<void> => {
    if (!result.ok) {
      error = {
        tag: result.error._tag,
        code: result.error.code,
        message: messageOf(result.error._tag),
      }
      return
    }
    const ticket = result.value.ticket
    // ADR-0069: persist the handle in localStorage so a same-device
    // re-open survives tab close / browser restart. /ticket reads
    // this cache + revalidates via GET /tickets/by-handle. The URL
    // intentionally carries only the ticketId — no PII, no QR
    // credential leak — and the ticket page falls back to /recover
    // if the cache is empty on a recipient device.
    writeTicketCache({
      ticketId: ticket.id,
      nameKana: ticket.nameKana ?? nameKana,
      phoneLast4: ticket.phoneLast4 ?? phoneLast4,
      lastKnownState: ticket.state,
    })
    await goto(`/ticket?id=${encodeURIComponent(ticket.id)}`)
  }

  const reportNetworkError = (e: unknown): void => {
    error = {
      tag: "NetworkError",
      code: "E_NET_FAIL",
      message: e instanceof Error ? e.message : "ネットワーク接続を確認してください",
    }
  }

  const onWalkInSubmit = (event: SubmitEvent): void => {
    event.preventDefault()
    void submitWalkIn()
  }

  const onReservationSubmit = (event: SubmitEvent): void => {
    event.preventDefault()
    void submitReservation()
  }

  const messageOf = (tag: string): string => {
    switch (tag) {
      case "InvalidNameKana":
        return "お名前はカタカナ + 空白のみで入力してください"
      case "InvalidPhoneLast4":
        return "電話番号は末尾 4 桁の数字で入力してください"
      case "InvalidFreeText":
        return "用件は 200 文字以内で入力してください"
      case "InvalidBody":
        return "送信内容に不備があります"
      case "RateLimited":
        return "しばらく時間をおいて再度お試しください"
      case "SlotFull":
        return "選択した時間枠は満席です。 別の時間をお選びください"
      case "SlotInPast":
        return "過去の時間は選択できません"
      default:
        return "送信できませんでした (エラーコード参照)"
    }
  }

  const slotsForDate = (date: string): readonly SlotEntry[] =>
    slots.filter((s) => s.date === date && s.granularity === GRANULARITY)

  const labelOfBucket = (bucketId: number): string => {
    const minutes = bucketId * GRANULARITY
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0")
    const mm = String(minutes % 60).padStart(2, "0")
    return `${hh}:${mm}`
  }
</script>

<svelte:head>
  <title>並ぶ — 整理券</title>
</svelte:head>

{#if !booting}
<section class="issue">
  <h1>並ぶ</h1>
  <p class="lede">名前と電話番号末尾4桁、 用件 (任意) を入力して列に加わります。</p>

  <form onsubmit={onWalkInSubmit}>
    <label class="field">
      <span class="label">お名前 (カタカナ)</span>
      <input
        type="text"
        value={nameKana}
        oninput={onNameInput}
        required
        placeholder="ヤマダ タロウ"
        autocomplete="off"
      />
    </label>

    <PhoneOtpInput bind:value={phoneLast4} />

    <label class="field">
      <span class="label">用件 (任意)</span>
      <textarea bind:value={freeText} rows="2" placeholder="ご相談内容など"></textarea>
    </label>

    {#if error !== null}
      <ErrorCard tag={error.tag} code={error.code} message={error.message} />
    {/if}

    <Button type="submit" size="lg" fullWidth disabled={busy}>
      {busy ? "送信中…" : "番号札を取る"}
    </Button>

    <p class="hint">送信後は番号が発行され、 列の進みを確認できます。</p>
  </form>

  <details class="reservation" ontoggle={onReservationToggle}>
    <summary>▶ 予約する (時間を指定)</summary>
    <div class="reservation-body">
      <div class="date-tabs" role="tablist">
        {#each dateTabs as tab (tab.iso)}
          <button
            type="button"
            class:active={selectedDate === tab.iso}
            class="date-tab"
            role="tab"
            aria-selected={selectedDate === tab.iso}
            onclick={() => {
              selectedDate = tab.iso
              selectedBucketId = null
            }}
          >
            {tab.label}
          </button>
        {/each}
      </div>

      {#if slotsLoading}
        <p class="loading">空き枠を読み込み中…</p>
      {:else if slotsForDate(selectedDate).length === 0}
        <p class="empty">空き枠はありません</p>
      {:else}
        <div class="slot-grid">
          {#each slotsForDate(selectedDate) as slot (`${slot.date}-${slot.bucketId}`)}
            <button
              type="button"
              class:selected={selectedBucketId === slot.bucketId}
              class:full={slot.available === 0}
              class="slot-cell"
              disabled={slot.available === 0}
              aria-label={slot.available === 0
                ? `${labelOfBucket(slot.bucketId)} 満席`
                : `${labelOfBucket(slot.bucketId)} 残り ${slot.available} 枠`}
              onclick={() => {
                selectedBucketId = slot.bucketId
              }}
            >
              <span class="slot-time">{labelOfBucket(slot.bucketId)}</span>
              <span class="slot-meta">
                {slot.available === 0 ? "満席" : `残${slot.available}`}
              </span>
            </button>
          {/each}
        </div>
      {/if}

      <form onsubmit={onReservationSubmit}>
        <Button
          type="submit"
          size="md"
          fullWidth
          disabled={busy || selectedBucketId === null}
        >
          {busy ? "送信中…" : "この時間で予約"}
        </Button>
      </form>
    </div>
  </details>
</section>
{/if}

<style>
  .issue {
    max-width: 28rem;
    margin: var(--space-12) auto;
    padding: 0 var(--space-4);
  }
  h1 {
    font: var(--text-numeral-md);
    margin: 0 0 var(--space-2);
  }
  .lede {
    color: var(--color-fg-muted);
    font: var(--text-body-md);
    margin: 0 0 var(--space-6);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .label {
    font: var(--text-label-md);
    color: var(--color-fg-secondary);
  }
  input,
  textarea {
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
  }
  textarea {
    resize: vertical;
    min-height: 4rem;
  }
  .hint {
    margin: 0;
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
  }
  .reservation {
    margin-top: var(--space-8);
    border-top: 1px solid var(--color-border-strong);
    padding-top: var(--space-4);
  }
  .reservation summary {
    cursor: pointer;
    color: var(--color-fg-secondary);
    font: var(--text-label-md);
  }
  .reservation-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin-top: var(--space-4);
  }
  .date-tabs {
    display: flex;
    gap: var(--space-2);
  }
  .date-tab {
    flex: 1;
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
  }
  .date-tab.active {
    background: var(--color-bg-accent);
    color: var(--color-fg-on-accent);
    border-color: var(--color-bg-accent);
  }
  .slot-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-2);
  }
  .slot-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-1);
    cursor: pointer;
  }
  .slot-cell.selected {
    background: var(--color-bg-accent);
    color: var(--color-fg-on-accent);
    border-color: var(--color-bg-accent);
  }
  .slot-cell.full {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .slot-time {
    font: var(--text-label-md);
  }
  .slot-meta {
    font: var(--text-body-sm);
    color: var(--color-fg-muted);
  }
  .slot-cell.selected .slot-meta {
    color: var(--color-fg-on-accent);
  }
  .loading,
  .empty {
    margin: 0;
    color: var(--color-fg-muted);
    font: var(--text-body-sm);
  }
</style>
