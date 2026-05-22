<script lang="ts">
  import { goto } from "$app/navigation"
  import { onMount } from "svelte"
  import { issueTicket } from "$lib/api.js"
  import Button from "$lib/components/Button.svelte"
  import ErrorCard from "$lib/components/ErrorCard.svelte"
  import Help from "$lib/components/Help.svelte"
  import PhoneOtpInput from "$lib/components/PhoneOtpInput.svelte"
  import SlotPicker from "$lib/components/SlotPicker.svelte"
  import { containsHiragana, toKatakana, validateNameKana } from "$lib/kana.js"
  import { errorMessage, helpText, m } from "$lib/messages.js"
  import { hasStaffToken, readTicketCache, writeTicketCache } from "$lib/ticketCache.js"

  let nameKana = $state("")
  let phoneLast4 = $state("")
  let freeText = $state("")
  let busy = $state(false)
  let error: { tag: string; code: string; message: string } | null = $state(null)
  let reservationOpen = $state(false)
  let selectedSlotISO: string | null = $state(null)

  // Client-side mirror of the server's NameKana / PhoneLast4 schemas.
  // The server is still the source of truth; these are here to block
  // an obviously-invalid submission (kanji / ASCII / wrong-length
  // phone) before the round-trip and to surface an inline reason the
  // customer can act on. `nameKanaError` is null when the input is
  // empty (don't nag before the customer types) or valid.
  const nameKanaError = $derived.by((): string | null => {
    const result = validateNameKana(nameKana)
    switch (result) {
      case "ok":
      case "empty":
        return null
      case "too_long":
        return m.name_kana_error_too_long()
      case "invalid_chars":
        return m.name_kana_error_invalid_chars()
    }
  })
  const phoneLast4Filled = $derived(phoneLast4.length === 4)
  const canSubmit = $derived(
    !busy && nameKana.length > 0 && nameKanaError === null && phoneLast4Filled,
  )
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

  // ひらがな→カタカナ変換は IME 確定 (compositionend) と非 IME 入力時のみ実行。
  // composition 中に DOM や `nameKana` を書き換えると IME が再 emit して
  // 「さとう」が「サササトサトウ」化するので絶対に触らない (compositionupdate での
  // DOM 直書きも試したが、 IME の状態を多重壊しするだけで余計悪化した)。
  // ユーザには「IME で hiragana を打って Enter で確定するとカタカナになる」UX。
  const onNameInput = (event: Event): void => {
    if ((event as InputEvent).isComposing) return
    nameKana = toKatakana(nameKana)
  }
  const onNameCompositionEnd = (): void => {
    nameKana = toKatakana(nameKana)
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
        message: m.issue_error_slot_required(),
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
      nameKana: ticket.nameKana,
      phoneLast4: ticket.phoneLast4,
      lastKnownState: ticket.state,
    })
    await goto(`/ticket?id=${encodeURIComponent(ticket.id)}`)
  }

  const reportNetworkError = (e: unknown): void => {
    error = {
      tag: "NetworkError",
      code: "E_NET_FAIL",
      message: e instanceof Error ? e.message : m.common_error_network(),
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
  <title>{m.issue_title()}</title>
</svelte:head>

{#if !booting}
<section class="issue">
  <h1>{m.issue_h1()}</h1>

  <form onsubmit={onWalkInSubmit}>
    <label class="field">
      <span class="label">{m.name_kana_label()}</span>
      <input
        type="text"
        bind:value={nameKana}
        oninput={onNameInput}
        oncompositionend={onNameCompositionEnd}
        required
        aria-invalid={nameKanaError !== null}
        placeholder={m.name_kana_placeholder()}
        autocomplete="off"
      />
      {#if nameKanaError !== null}
        <p class="kana-error" role="alert">{nameKanaError}</p>
      {:else if containsHiragana(nameKana)}
        <p class="kana-preview" aria-live="polite">
          {m.name_kana_preview({ katakana: toKatakana(nameKana) })}
        </p>
      {/if}
    </label>

    <PhoneOtpInput bind:value={phoneLast4} />

    <label class="field">
      <span class="label">{m.issue_freetext_label()}</span>
      <textarea
        bind:value={freeText}
        rows="2"
        placeholder={m.issue_freetext_placeholder()}
      ></textarea>
    </label>

    {#if error !== null}
      <ErrorCard tag={error.tag} code={error.code} message={error.message} />
    {/if}

    <Button type="submit" size="lg" fullWidth disabled={!canSubmit}>
      {busy ? m.common_submit_busy() : m.issue_submit_walkin()}
    </Button>
  </form>

  <details class="reservation" ontoggle={onReservationToggle}>
    <summary>
      <span>{m.issue_reservation_summary()}</span>
      <Help text={helpText("slotPicker")} label={m.issue_reservation_help_label()} />
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
          disabled={!canSubmit || selectedSlotISO === null}
        >
          {busy ? m.common_submit_busy() : m.issue_submit_reservation()}
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
  /* IME 確定前のひらがな入力中に「カタカナにするとこうなる」を視覚プレビュー。
   * input 自体には触らないので IME composition が壊れない。 */
  .kana-preview {
    margin: 0;
    font: var(--text-body-sm);
    color: var(--color-fg-muted);
  }
  /* 漢字 / ASCII / 記号など、 カタカナにできない入力が確定された時の警告。
   * 送信ボタンも別途 disabled になるので進めない。 */
  .kana-error {
    margin: 0;
    font: var(--text-body-sm);
    color: var(--color-state-danger);
    font-weight: 500;
  }
  input[aria-invalid="true"] {
    border-color: var(--color-state-danger);
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
