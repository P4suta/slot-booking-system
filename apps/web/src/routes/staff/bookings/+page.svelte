<script lang="ts">
  // Staff bookings list — placeholder pending the per-day bookings
  // GraphQL read query (Phase 0.11-8). The dashboard frame is here so
  // the route exists; the page renders an empty state until the query
  // is wired up.
  let date = $state(new Date().toISOString().slice(0, 10))
</script>

<h1>本日の予約</h1>

<label>
  日付
  <input type="date" bind:value={date} />
</label>

<p>このビューは Phase 0.12 で完成予定です。</p>
