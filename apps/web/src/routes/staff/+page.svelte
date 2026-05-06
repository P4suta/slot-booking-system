<script lang="ts">
  // Staff dashboard. Cloudflare Access JWT validation lives in
  // `+page.server.ts` (Phase 0.11-7). For local dev the JWT is
  // mocked through an `X-Staff-Capability` header set in the
  // browser session — see the README for the seed flow.
</script>

<h1>Staff Dashboard</h1>

<ul>
  <li><a href="/staff/bookings">本日の予約</a></li>
  <li><a href="/staff/catalog">カタログ管理</a></li>
</ul>
