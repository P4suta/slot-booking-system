<script lang="ts">
  import { goto } from "$app/navigation"
  import { execute } from "$lib/graphql/client.js"
  import { graphqlEndpoint } from "$lib/graphql/endpoint.js"
  import {
    AvailableSlotsQuery,
    type AvailableSlot,
    ServicesQuery,
    type Service,
  } from "$lib/graphql/queries.js"

  let services = $state<readonly Service[]>([])
  let serviceId = $state("")
  let date = $state(new Date().toISOString().slice(0, 10))
  let slots = $state<readonly AvailableSlot[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)

  $effect(() => {
    void (async () => {
      try {
        const data = await execute(ServicesQuery, {}, { endpoint: graphqlEndpoint() })
        services = (data.services ?? [])
          .filter((s): s is Service => s !== null && s.enabled === true)
        if (services.length > 0 && serviceId === "") {
          const first = services[0]
          if (first?.id != null) serviceId = first.id
        }
      } catch (e) {
        error = e instanceof Error ? e.message : "failed to load services"
      }
    })()
  })

  const search = async (): Promise<void> => {
    if (serviceId === "") return
    loading = true
    error = null
    try {
      const data = await execute(
        AvailableSlotsQuery,
        { serviceId, date },
        { endpoint: graphqlEndpoint() },
      )
      slots = (data.availableSlots ?? []).filter((s): s is AvailableSlot => s !== null)
    } catch (e) {
      error = e instanceof Error ? e.message : "search failed"
    } finally {
      loading = false
    }
  }

  const pick = (slot: AvailableSlot): void => {
    sessionStorage.setItem("booking.selectedSlot", JSON.stringify({ slot, date, serviceId }))
    void goto("/customer/hold")
  }

  const formatTime = (iso: string | null): string => {
    if (iso === null) return "—"
    const dt = new Date(iso)
    return dt.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
  }
</script>

<h1>空き枠検索</h1>

<form
  onsubmit={(event) => {
    event.preventDefault()
    void search()
  }}
  aria-label="空き枠検索フォーム"
>
  <label>
    サービス
    <select bind:value={serviceId} required>
      {#each services as service (service.id)}
        <option value={service.id}>{service.name} ({service.durationMinutes}分)</option>
      {/each}
    </select>
  </label>

  <label>
    日付
    <input type="date" bind:value={date} required />
  </label>

  <button type="submit" disabled={loading || serviceId === ""}>
    {loading ? "検索中..." : "検索"}
  </button>
</form>

{#if error}
  <p role="alert" class="error">{error}</p>
{/if}

{#if slots.length > 0}
  <h2>{slots.length} 件の空き枠</h2>
  <ul aria-label="空き枠一覧">
    {#each slots as slot, i (slot.token)}
      <li>
        <button
          type="button"
          onclick={() => pick(slot)}
          aria-label={`${formatTime(slot.start)} から ${formatTime(slot.end)} の枠を選択`}
        >
          {formatTime(slot.start)} – {formatTime(slot.end)}
        </button>
      </li>
    {/each}
  </ul>
{:else if !loading && !error && serviceId !== ""}
  <p>検索条件を入力して「検索」を押してください</p>
{/if}

<style>
  .error {
    color: #c00;
    background: #fee;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
  }
  ul {
    list-style: none;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
    gap: 0.5rem;
  }
  li button {
    width: 100%;
  }
</style>
