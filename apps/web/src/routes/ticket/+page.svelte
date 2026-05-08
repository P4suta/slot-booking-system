<script lang="ts">
  import { onDestroy, onMount } from "svelte"
  import { cancelTicket, myTicket, queueEventSource, shopState, type Ticket } from "$lib/api.js"
  import PhoneOtpInput from "$lib/components/PhoneOtpInput.svelte"
  import { toKatakana } from "$lib/kana.js"

  type Stored = { ticketId: string; nameKana: string; phoneLast4: string }

  const onNameInput = (event: Event): void => {
    const el = event.currentTarget as HTMLInputElement
    lookupForm.nameKana = toKatakana(el.value)
  }

  let stored: Stored | null = $state(null)
  let lookupForm = $state({ ticketId: "", nameKana: "", phoneLast4: "" })
  let ticket: Ticket | null = $state(null)
  let waitingCount = $state(0)
  let position: number | null = $state(null)
  let error: string | null = $state(null)
  let cancelBusy = $state(false)
  let source: EventSource | undefined

  const readStored = (): Stored | null => {
    if (typeof window === "undefined") return null
    try {
      const fragment = window.location.hash
      if (fragment.startsWith("#id=")) {
        const id = fragment.slice(4)
        const fromSession = sessionStorage.getItem("queue.ticket")
        if (fromSession !== null) {
          const parsed = JSON.parse(fromSession) as Stored
          if (parsed.ticketId === id) return parsed
        }
      }
      const fromSession = sessionStorage.getItem("queue.ticket")
      if (fromSession !== null) return JSON.parse(fromSession) as Stored
    } catch {
      return null
    }
    return null
  }

  /**
   * Re-fetch the customer's own ticket + the public shop state.
   * Network errors never throw — they surface in `error` and the
   * previous state stays on screen.
   */
  const refresh = async (id: Stored): Promise<void> => {
    try {
      const r = await myTicket(id)
      if (!r.ok) {
        error = `myTicket: ${r.error._tag} (${r.error.code})`
        return
      }
      ticket = (r.value as unknown as { ticket: Ticket }).ticket
      error = null
      const s = await shopState()
      if (s.ok) {
        const data = s.value as unknown as {
          waitingCount: number
          waitingPreview: { id: string; seq: number }[]
        }
        waitingCount = data.waitingCount
        if (ticket?.state === "Waiting") {
          const idx = data.waitingPreview.findIndex((t) => t.id === ticket?.id)
          position = idx >= 0 ? idx : null
        } else {
          position = null
        }
      }
    } catch (e) {
      error = `refresh: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  const onLookup = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    const next: Stored = { ...lookupForm }
    sessionStorage.setItem("queue.ticket", JSON.stringify(next))
    stored = next
    await refresh(next)
  }

  const onCancel = async (): Promise<void> => {
    if (stored === null) return
    cancelBusy = true
    error = null
    try {
      const r = await cancelTicket(stored.ticketId, {
        nameKana: stored.nameKana,
        phoneLast4: stored.phoneLast4,
        reason: "customer cancellation",
      })
      if (!r.ok) {
        error = `cancel: ${r.error._tag} (${r.error.code})`
        return
      }
      ticket = (r.value as unknown as { ticket: Ticket }).ticket
    } catch (e) {
      error = `cancel: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      cancelBusy = false
    }
  }

  onMount(async () => {
    stored = readStored()
    if (stored !== null) await refresh(stored)
    source = queueEventSource()
    source.onmessage = () => {
      // 直後に成功 event = backend 健在、 reconnect banner を解除
      if (error?.startsWith("live feed:") === true) error = null
      if (stored !== null) void refresh(stored)
    }
    source.onerror = () => {
      // SSE は 30 秒ごとに server 側で close → client 自動 reconnect
      // (Workers の stream 予算対策)。 CONNECTING 中は表示せず、
      // CLOSED に陥ったときだけ surface する。
      if (source?.readyState === EventSource.CLOSED) {
        error = "live feed: closed (再読み込みで再接続)"
      }
    }
  })

  onDestroy(() => source?.close())
</script>

<section>
  {#if stored === null}
    <h1>番号を確認</h1>
    <p class="lede">発行された番号と入力情報で行列の状況を確認できます。</p>
    <form onsubmit={onLookup}>
      <label>
        <span>番号</span>
        <input type="text" bind:value={lookupForm.ticketId} required placeholder="tkt_..." />
      </label>
      <label>
        <span>お名前 (カタカナ)</span>
        <input type="text" value={lookupForm.nameKana} oninput={onNameInput} required />
      </label>
      <PhoneOtpInput bind:value={lookupForm.phoneLast4} />
      <button type="submit">確認</button>
    </form>
  {:else if ticket !== null}
    <h1>番号 #{ticket.seq}</h1>
    <p class="state">状態: <strong>{ticket.state}</strong></p>
    {#if ticket.state === "Waiting" && position !== null}
      <p class="position">あなたの前に <strong>{position}</strong> 人</p>
      <p class="total">列全体で {waitingCount} 人待ち</p>
    {:else if ticket.state === "Called"}
      <p class="position called">呼び出し中です — 受付までお越しください</p>
    {:else if ticket.state === "Served"}
      <p class="position served">対応完了しました。 ご利用ありがとうございました。</p>
    {:else if ticket.state === "NoShow"}
      <p class="position noshow">不在のため呼び出しは取り消されました。</p>
    {:else if ticket.state === "Cancelled"}
      <p class="position cancelled">キャンセル済み</p>
    {/if}
    {#if ticket.state === "Waiting" || ticket.state === "Called"}
      <button class="cancel" onclick={onCancel} disabled={cancelBusy}>
        {cancelBusy ? "処理中…" : "キャンセル"}
      </button>
    {/if}
    {#if error !== null}
      <p class="error">エラー: {error}</p>
    {/if}
  {:else if error !== null}
    <p class="error">エラー: {error}</p>
  {/if}
</section>

<style>
  section {
    max-width: 28rem;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  h1 {
    margin: 0 0 0.5rem;
    font-size: 3rem;
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
  input {
    padding: 0.7rem;
    border: 1px solid #d2d2d7;
    border-radius: 8px;
    font-size: 1rem;
  }
  input:focus {
    outline: 2px solid #0071e3;
    border-color: transparent;
  }
  button {
    padding: 0.9rem;
    background: #1d1d1f;
    color: white;
    border: none;
    border-radius: 999px;
    font-size: 1rem;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
  }
  .state {
    color: #6e6e73;
  }
  .state strong {
    color: #1d1d1f;
  }
  .position {
    background: #f5f5f7;
    padding: 1rem;
    border-radius: 12px;
    margin: 1rem 0;
  }
  .position strong {
    font-size: 2rem;
    color: #1d1d1f;
  }
  .total {
    color: #86868b;
    font-size: 0.9rem;
    margin: 0;
  }
  .called {
    background: #fff8e1;
  }
  .served {
    background: #e8f5e9;
  }
  .noshow,
  .cancelled {
    background: #f5f5f7;
    color: #86868b;
  }
  .cancel {
    background: #c11;
    color: white;
  }
  .error {
    color: #c11;
    background: #fff1f0;
    padding: 0.75rem;
    border-radius: 8px;
    margin: 1rem 0 0;
  }
</style>
