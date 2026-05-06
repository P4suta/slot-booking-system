<script lang="ts">
  import { execute } from "$lib/graphql/client.js"
  import { graphqlEndpoint } from "$lib/graphql/endpoint.js"
  import { CancelBookingMutation } from "$lib/graphql/queries.js"

  let bookingCode = $state("")
  let phoneLast4 = $state("")
  let date = $state(new Date().toISOString().slice(0, 10))
  let reason = $state("")
  let submitting = $state(false)
  let error = $state<string | null>(null)
  let result = $state<string | null>(null)

  const cancel = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    submitting = true
    error = null
    result = null
    try {
      const data = await execute(
        CancelBookingMutation,
        { date, code: bookingCode, phoneLast4, reason: reason || "customer-request" },
        { endpoint: graphqlEndpoint() },
      )
      if (data.cancelBooking.__typename === "BookingError") {
        error = data.cancelBooking.message
      } else {
        result = `キャンセル完了 (state=${data.cancelBooking.state})`
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "failed"
    } finally {
      submitting = false
    }
  }
</script>

<h1>予約管理</h1>
<p>予約コードと電話番号下4桁を入力してください。</p>

<form onsubmit={cancel} aria-label="予約管理フォーム">
  <label>
    予約日
    <input type="date" bind:value={date} required />
  </label>
  <label>
    予約コード
    <input bind:value={bookingCode} required />
  </label>
  <label>
    電話番号 下4桁
    <input bind:value={phoneLast4} required pattern="[0-9]{4}" inputmode="numeric" />
  </label>
  <label>
    キャンセル理由
    <input bind:value={reason} maxlength="80" />
  </label>
  <button type="submit" disabled={submitting}>
    {submitting ? "処理中..." : "キャンセルする"}
  </button>
</form>

{#if error}
  <p role="alert" class="error">{error}</p>
{/if}
{#if result}
  <p class="ok">{result}</p>
{/if}

<style>
  .error {
    color: #c00;
  }
  .ok {
    color: #060;
  }
</style>
