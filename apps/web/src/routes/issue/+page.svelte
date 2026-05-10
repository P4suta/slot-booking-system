<script lang="ts">
  import { goto } from "$app/navigation"
  import { onMount } from "svelte"
  import { issueTicket } from "$lib/api.js"
  import Button from "$lib/components/Button.svelte"
  import ErrorCard from "$lib/components/ErrorCard.svelte"
  import Help from "$lib/components/Help.svelte"
  import PhoneOtpInput from "$lib/components/PhoneOtpInput.svelte"
  import SlotPicker from "$lib/components/SlotPicker.svelte"
  import { toKatakana } from "$lib/kana.js"
  import { errorMessage, helpText } from "$lib/messages.js"
  import { hasStaffToken, readTicketCache, writeTicketCache } from "$lib/ticketCache.js"

  let nameKana = $state("")
  let phoneLast4 = $state("")
  let freeText = $state("")
  let busy = $state(false)
  let error: { tag: string; code: string; message: string } | null = $state(null)
  let reservationOpen = $state(false)
  let selectedSlotISO: string | null = $state(null)
  // ADR-0069 §Stage 8 — same-handle re-issue would just merge into
  // the existing ticket and goto /ticket anyway; pre-empt the
  // round-trip by bouncing to /ticket the moment we see a cache hit.
  let booting = $state(true)

  onMount(async () => {
    // Stage 10: staff session sandbox — staff never lands on the
    // customer issue form even by typing the URL.
    if (hasStaffToken()) {
      await goto("/staff")
      return
    }
    const cached = readTicketCache()
    if (cached !== null) {
      await goto(`/ticket?id=${encodeURIComponent(cached.ticketId)}`)
      return
    }
    booting = false
  })

  // ひらがな入力を即座にカタカナへ昇格 (UX 配慮)。
  const onNameInput = (event: Event): void => {
    const el = event.currentTarget as HTMLInputElement
    nameKana = toKatakana(el.value)
  }

  const onReservationToggle = (event: Event): void => {
    const detail = event.currentTarget as HTMLDetailsElement
    reservationOpen = detail.open
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
    if (selectedSlotISO === null) {
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
        appointmentAt: selectedSlotISO,
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
        message: errorMessage(result.error._tag),
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
    <summary>
      <span>▶ 予約する (時間を指定)</span>
      <Help text={helpText("slotPicker")} label="予約の説明を表示" />
    </summary>
    <div class="reservation-body">
      <SlotPicker
        selectedISO={selectedSlotISO}
        onSelect={(iso) => {
          selectedSlotISO = iso
        }}
        enabled={reservationOpen}
      />

      <form onsubmit={onReservationSubmit}>
        <Button
          type="submit"
          size="md"
          fullWidth
          disabled={busy || selectedSlotISO === null}
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
</style>
