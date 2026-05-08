<script lang="ts">
  import { goto } from "$app/navigation"
  import { issueTicket } from "$lib/api.js"
  import PhoneOtpInput from "$lib/components/PhoneOtpInput.svelte"
  import { toKatakana } from "$lib/kana.js"

  let nameKana = $state("")
  let phoneLast4 = $state("")
  let freeText = $state("")
  let busy = $state(false)
  let error: string | null = $state(null)

  // ひらがな入力を即座にカタカナへ昇格 (UX 配慮)。 worker 側の
  // `parseNameKana` はカタカナ + 半角カナ + 空白のみ受け付けるため、
  // ひらがなのまま submit すると即 InvalidNameKana で弾かれる。
  const onNameInput = (event: Event): void => {
    const el = event.currentTarget as HTMLInputElement
    nameKana = toKatakana(el.value)
  }

  const onSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    error = null
    busy = true
    try {
      const result = await issueTicket({
        nameKana,
        phoneLast4,
        freeText: freeText.length === 0 ? null : freeText,
      })
      if (!result.ok) {
        error = `issue: ${result.error._tag} (${result.error.code})`
        return
      }
      const ticketId = (result.value as unknown as { ticket: { id: string } }).ticket.id
      sessionStorage.setItem(
        "queue.ticket",
        JSON.stringify({ ticketId, nameKana, phoneLast4 }),
      )
      await goto(`/ticket#id=${ticketId}`)
    } catch (e) {
      error = `issue: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      busy = false
    }
  }
</script>

<section>
  <h1>並ぶ</h1>
  <p class="lede">名前と電話番号末尾4桁、 用件 (任意) を入力して列に加わります。</p>
  <form onsubmit={onSubmit}>
    <label>
      <span>お名前 (カタカナ)</span>
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
    <label>
      <span>用件 (任意)</span>
      <textarea bind:value={freeText} rows="2" placeholder="ご相談内容など" />
    </label>
    {#if error !== null}
      <p class="error">エラー: {error}</p>
    {/if}
    <button type="submit" disabled={busy}>{busy ? "送信中…" : "並ぶ"}</button>
    <p class="hint">
      送信後は番号が発行され、 列の進みを <a href="/ticket">ticket panel</a> で確認できます。
    </p>
  </form>
</section>

<style>
  section {
    max-width: 28rem;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  h1 {
    margin: 0 0 0.5rem;
  }
  .lede {
    color: #6e6e73;
    margin: 0 0 1.5rem;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  span {
    font-weight: 500;
    font-size: 0.9rem;
  }
  input,
  textarea {
    padding: 0.7rem;
    border: 1px solid #d2d2d7;
    border-radius: 8px;
    font-size: 1rem;
    font-family: inherit;
  }
  input:focus,
  textarea:focus {
    outline: 2px solid #0071e3;
    border-color: transparent;
  }
  button {
    margin-top: 0.5rem;
    padding: 0.9rem;
    background: #1d1d1f;
    color: white;
    border: none;
    border-radius: 999px;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .error {
    color: #c11;
    background: #fff1f0;
    padding: 0.75rem;
    border-radius: 8px;
    margin: 0;
  }
  .hint {
    margin: 0;
    color: #86868b;
    font-size: 0.85rem;
  }
</style>
