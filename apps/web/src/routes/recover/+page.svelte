<script lang="ts">
  import { goto } from "$app/navigation"
  import { page } from "$app/state"
  import { onMount } from "svelte"
  import { myTicket } from "$lib/api.js"
  import Button from "$lib/components/Button.svelte"
  import ErrorCard from "$lib/components/ErrorCard.svelte"
  import PhoneOtpInput from "$lib/components/PhoneOtpInput.svelte"
  import { toKatakana } from "$lib/kana.js"

  let ticketId = $state("")
  let nameKana = $state("")
  let phoneLast4 = $state("")
  let busy = $state(false)
  let error: { tag: string; code: string; message: string } | null = $state(null)

  // Pre-fill ticketId from `?id=` query param when the customer
  // arrives via the share-safe `/recover?id=...` form. The handle
  // (kana + last4) is always typed by the user — never by URL —
  // so a recipient who only got the share link cannot bypass the
  // verification (ADR-0064 share-safety).
  onMount(() => {
    const id = page.url.searchParams.get("id")
    if (id !== null) ticketId = id
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
      const r = await myTicket({ ticketId, nameKana, phoneLast4 })
      if (!r.ok) {
        error = {
          tag: r.error._tag,
          code: r.error.code,
          message: messageOf(r.error._tag),
        }
        return
      }
      const t = r.value.ticket
      sessionStorage.setItem(
        "queue.ticket",
        JSON.stringify({
          ticketId: t.id,
          nameKana: t.nameKana,
          phoneLast4: t.phoneLast4,
        }),
      )
      const params = new URLSearchParams({
        id: t.id,
        k: t.nameKana ?? nameKana,
        p: t.phoneLast4 ?? phoneLast4,
      })
      await goto(`/ticket?${params.toString()}`)
    } catch (e) {
      error = {
        tag: "NetworkError",
        code: "E_NET_FAIL",
        message: e instanceof Error ? e.message : "ネットワーク接続を確認してください",
      }
    } finally {
      busy = false
    }
  }

  const messageOf = (tag: string): string => {
    switch (tag) {
      case "TicketNotFound":
        return "番号が見つかりません。 ticket id を確認してください"
      case "PhoneMismatch":
        return "名前または電話番号末尾が一致しません"
      case "InvalidNameKana":
        return "お名前はカタカナ + 空白のみで入力してください"
      case "InvalidPhoneLast4":
        return "電話番号は末尾 4 桁の数字で入力してください"
      case "InvalidEntityId":
        return "ticket id の形式が正しくありません"
      default:
        return "情報を取得できませんでした"
    }
  }
</script>

<svelte:head>
  <title>番号を確認 — 整理券</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<section class="recover">
  <h1>番号を確認</h1>
  <p class="lede">
    お名前 (カタカナ) と電話番号末尾 4 桁を入力すると、 ご自分の番号画面を開けます。
  </p>

  <form onsubmit={onSubmit}>
    <label class="field">
      <span class="label">ticket id</span>
      <input
        type="text"
        bind:value={ticketId}
        required
        placeholder="tkt_..."
        autocomplete="off"
      />
    </label>

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

<style>
  .recover {
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
  input {
    background: var(--color-bg-raised);
    color: var(--color-fg-primary);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
  }
</style>
