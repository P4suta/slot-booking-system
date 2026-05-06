<script lang="ts">
  import { goto } from "$app/navigation"
  import { onMount } from "svelte"
  import { execute } from "$lib/graphql/client.js"
  import { graphqlEndpoint } from "$lib/graphql/endpoint.js"
  import { HoldSlotMutation, type AvailableSlot } from "$lib/graphql/queries.js"

  let selected = $state<{ slot: AvailableSlot; date: string; serviceId: string } | null>(null)
  let nameKana = $state("")
  let phoneLast4 = $state("")
  let freeText = $state("")
  let submitting = $state(false)
  let error = $state<string | null>(null)

  onMount(() => {
    const raw = sessionStorage.getItem("booking.selectedSlot")
    if (!raw) {
      void goto("/customer/search")
      return
    }
    selected = JSON.parse(raw) as typeof selected
  })

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (!selected) return
    submitting = true
    error = null
    try {
      const data = await execute(
        HoldSlotMutation,
        {
          date: selected.date,
          slotToken: selected.slot.token,
          nameKana,
          phoneLast4,
          source: "online",
          freeText: freeText.length > 0 ? freeText : undefined,
        },
        { endpoint: graphqlEndpoint() },
      )
      if (data.holdSlot.__typename === "BookingError") {
        error = data.holdSlot.message
        return
      }
      sessionStorage.setItem(
        "booking.held",
        JSON.stringify({ bookingId: data.holdSlot.bookingId, ...selected, phoneLast4 }),
      )
      void goto("/customer/confirm")
    } catch (e) {
      error = e instanceof Error ? e.message : "failed"
    } finally {
      submitting = false
    }
  }
</script>

<h1>仮予約</h1>

{#if !selected}
  <p>選択された枠がありません。<a href="/customer/search">検索に戻る</a>。</p>
{:else}
  <p>
    {new Date(selected.slot.start).toLocaleString("ja-JP")}
    〜
    {new Date(selected.slot.end).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
  </p>

  <form onsubmit={submit} aria-label="仮予約フォーム">
    <label>
      お名前(カナ)
      <input bind:value={nameKana} required maxlength="40" />
    </label>
    <label>
      電話番号 下4桁
      <input bind:value={phoneLast4} required pattern="[0-9]{4}" inputmode="numeric" />
    </label>
    <label>
      備考
      <textarea bind:value={freeText} maxlength="200"></textarea>
    </label>

    <button type="submit" disabled={submitting}>
      {submitting ? "仮予約中..." : "仮予約する"}
    </button>
  </form>

  {#if error}
    <p role="alert" class="error">{error}</p>
  {/if}
{/if}

<style>
  .error {
    color: #c00;
  }
  textarea {
    width: 100%;
    min-height: 4rem;
    font: inherit;
    padding: 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid #999;
  }
</style>
