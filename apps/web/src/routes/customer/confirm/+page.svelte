<script lang="ts">
  import { onMount } from "svelte"
  import { execute } from "$lib/graphql/client.js"
  import { graphqlEndpoint } from "$lib/graphql/endpoint.js"
  import { ConfirmBookingMutation } from "$lib/graphql/queries.js"
  import { localiseBookingError } from "$lib/i18n.js"

  let held = $state<{ bookingId: string; date: string; phoneLast4: string } | null>(null)
  let bookingCode = $state("")
  let submitting = $state(false)
  let error = $state<string | null>(null)
  let confirmedAt = $state<string | null>(null)

  // 5-minute hold timer counts down from `expiresAt`. Phase 0.10 holds
  // for 5 min from the DO clock, but the client UX only needs an
  // approximate countdown.
  let secondsLeft = $state(5 * 60)
  let timerHandle: ReturnType<typeof setInterval> | null = null

  onMount(() => {
    const raw = sessionStorage.getItem("booking.held")
    if (!raw) return
    held = JSON.parse(raw) as typeof held
    timerHandle = setInterval(() => {
      secondsLeft = Math.max(0, secondsLeft - 1)
      if (secondsLeft === 0 && timerHandle !== null) {
        clearInterval(timerHandle)
        timerHandle = null
      }
    }, 1000)
    return () => {
      if (timerHandle !== null) clearInterval(timerHandle)
    }
  })

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (!held) return
    submitting = true
    error = null
    try {
      const data = await execute(
        ConfirmBookingMutation,
        { date: held.date, code: bookingCode, phoneLast4: held.phoneLast4 },
        { endpoint: graphqlEndpoint() },
      )
      const result = data.confirmBooking
      if (result === null) {
        error = "失敗しました。"
        return
      }
      if (result.__typename === "BookingError") {
        error = localiseBookingError(result)
        return
      }
      confirmedAt = new Date().toISOString()
      sessionStorage.removeItem("booking.held")
      sessionStorage.removeItem("booking.selectedSlot")
    } catch (e) {
      error = e instanceof Error ? e.message : "failed"
    } finally {
      submitting = false
    }
  }

  const formatCountdown = (s: number): string => {
    const m = Math.floor(s / 60)
    const ss = s % 60
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
  }
</script>

<h1>本予約</h1>

{#if confirmedAt}
  <p class="ok">予約が確定しました(コード: {bookingCode})。</p>
{:else if !held}
  <p>仮予約が見つかりません。<a href="/customer/search">最初からやり直す</a>。</p>
{:else}
  <p>
    残り時間: <strong aria-live="polite">{formatCountdown(secondsLeft)}</strong>
  </p>
  <form onsubmit={submit} aria-label="本予約フォーム">
    <label>
      予約コード
      <input bind:value={bookingCode} required maxlength="20" />
    </label>
    <button type="submit" disabled={submitting || secondsLeft === 0}>
      {submitting ? "確定中..." : "確定"}
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
  .ok {
    color: #060;
    font-weight: 600;
  }
</style>
