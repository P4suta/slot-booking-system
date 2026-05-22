<script lang="ts">
  import { goto } from "$app/navigation"
  import { onMount } from "svelte"
  import { ticketByHandle } from "$lib/api.js"
  import Button from "$lib/components/Button.svelte"
  import ErrorCard from "$lib/components/ErrorCard.svelte"
  import Help from "$lib/components/Help.svelte"
  import PhoneOtpInput from "$lib/components/PhoneOtpInput.svelte"
  import { containsHiragana, toKatakana, validateNameKana } from "$lib/kana.js"
  import { errorMessage, helpText, m } from "$lib/messages.js"
  import { hasStaffToken, readTicketCache, writeTicketCache } from "$lib/ticketCache.js"

  let nameKana = $state("")
  let phoneLast4 = $state("")
  let busy = $state(false)
  let error: { tag: string; code: string; message: string } | null = $state(null)
  // ADR-0069 §Stage 8 — if the device already holds the customer's
  // active ticket in localStorage, /recover is a wasted prompt;
  // bounce straight to /ticket.
  let booting = $state(true)

  // Client-side mirror of NameKanaSchema — same rationale as /issue:
  // block obviously-invalid submissions before the round-trip and
  // give the customer an actionable inline reason. Empty stays
  // silent (no nag before they type); the submit button gates on
  // the full form anyway.
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
  const canSubmit = $derived(
    !busy && nameKana.length > 0 && nameKanaError === null && phoneLast4.length === 4,
  )

  onMount(async () => {
    // Stage 10: staff session sandbox — staff token in localStorage
    // means an operator is at the keyboard; redirect to /staff so
    // the customer-recovery form does not impersonate a customer view.
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

  // ひらがな→カタカナ変換は IME 確定 (compositionend) のみ。 composition 中は
  // 触らない (詳細は /issue 側のコメント)。
  const onNameInput = (event: Event): void => {
    if ((event as InputEvent).isComposing) return
    nameKana = toKatakana(nameKana)
  }
  const onNameCompositionEnd = (): void => {
    nameKana = toKatakana(nameKana)
  }

  const onSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    error = null
    busy = true
    try {
      // ADR-0069: handle is the active-set primary key — kana + last4
      // alone resolve to the unique active ticket. No ticketId input,
      // no URL credential required.
      const r = await ticketByHandle({ nameKana, phoneLast4 })
      if (!r.ok) {
        error = {
          tag: r.error._tag,
          code: r.error.code,
          message: errorMessage(r.error._tag),
        }
        return
      }
      const t = r.value.ticket
      writeTicketCache({
        ticketId: t.id,
        nameKana: t.nameKana,
        phoneLast4: t.phoneLast4,
        lastKnownState: t.state,
      })
      await goto(`/ticket?id=${encodeURIComponent(t.id)}`)
    } catch (e) {
      error = {
        tag: "NetworkError",
        code: "E_NET_FAIL",
        message: e instanceof Error ? e.message : errorMessage("NetworkError"),
      }
    } finally {
      busy = false
    }
  }
</script>

<svelte:head>
  <title>{m.recover_title()}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

{#if !booting}
  <section class="recover">
    <h1>
      {m.recover_h1()}
      <Help text={helpText("recoverHandle")} label={m.recover_help_label()} />
    </h1>

    <form onsubmit={onSubmit}>
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

      {#if error !== null}
        <ErrorCard tag={error.tag} code={error.code} message={error.message} />
      {/if}

      <Button type="submit" size="lg" fullWidth disabled={!canSubmit}>
        {busy ? m.recover_submit_busy() : m.recover_submit()}
      </Button>
    </form>
  </section>
{/if}

<style>
  .recover {
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
  /* IME 確定前のひらがな→カタカナ視覚プレビュー (input には触らない)。 */
  .kana-preview {
    margin: 0;
    font: var(--text-body-sm);
    color: var(--color-fg-muted);
  }
  /* カタカナ化できない入力 (漢字 / ASCII / 記号) の警告。 */
  .kana-error {
    margin: 0;
    font: var(--text-body-sm);
    color: var(--color-state-danger);
    font-weight: 500;
  }
  input[aria-invalid="true"] {
    border-color: var(--color-state-danger);
  }
  input {
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
  }
</style>
