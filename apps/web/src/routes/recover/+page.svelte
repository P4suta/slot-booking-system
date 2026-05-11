<script lang="ts">
  import { goto } from "$app/navigation"
  import { onMount } from "svelte"
  import { ticketByHandle } from "$lib/api.js"
  import Button from "$lib/components/Button.svelte"
  import ErrorCard from "$lib/components/ErrorCard.svelte"
  import Help from "$lib/components/Help.svelte"
  import PhoneOtpInput from "$lib/components/PhoneOtpInput.svelte"
  import { toKatakana } from "$lib/kana.js"
  import { errorMessage, helpText } from "$lib/messages.js"
  import { hasStaffToken, readTicketCache, writeTicketCache } from "$lib/ticketCache.js"
  import { wsStatus } from "$lib/wsStatus.js"

  let nameKana = $state("")
  let phoneLast4 = $state("")
  let busy = $state(false)
  let error: { tag: string; code: string; message: string } | null = $state(null)
  // ADR-0069 §Stage 8 — if the device already holds the customer's
  // active ticket in localStorage, /recover is a wasted prompt;
  // bounce straight to /ticket.
  let booting = $state(true)

  onMount(async () => {
    // /recover does not subscribe to the projection feed (form-only
    // page). Mark the WS chip as inactive so the layout doesn't
    // render a stale "接続中…" inherited from a previous route.
    wsStatus.set("none")
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

  const onNameInput = (event: Event): void => {
    const el = event.currentTarget as HTMLInputElement
    nameKana = toKatakana(el.value)
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
        nameKana: t.nameKana ?? nameKana,
        phoneLast4: t.phoneLast4 ?? phoneLast4,
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
  <title>番号を確認 — 整理券</title>
  <meta name="robots" content="noindex" />
</svelte:head>

{#if !booting}
  <section class="recover">
    <h1>
      番号を確認
      <Help text={helpText("recoverHandle")} label="復帰の説明を表示" />
    </h1>
    <p class="lede">
      お名前 (カタカナ) と電話番号末尾 4 桁を入力すると、 ご自分の番号画面を開けます。
    </p>

    <form onsubmit={onSubmit}>
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

      {#if error !== null}
        <ErrorCard tag={error.tag} code={error.code} message={error.message} />
      {/if}

      <Button type="submit" size="lg" fullWidth disabled={busy}>
        {busy ? "確認中…" : "番号を表示"}
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
  @media (min-width: 48rem) {
    .recover {
      max-width: 32rem;
      padding: 0 var(--space-6);
    }
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
  input {
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
  }
</style>
