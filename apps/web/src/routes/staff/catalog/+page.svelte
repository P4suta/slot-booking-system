<script lang="ts">
  import { execute } from "$lib/graphql/client.js"
  import { graphqlEndpoint } from "$lib/graphql/endpoint.js"
  import { ServicesQuery, type Service } from "$lib/graphql/queries.js"

  let services = $state<readonly Service[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)

  $effect(() => {
    loading = true
    void (async () => {
      try {
        const data = await execute(ServicesQuery, {}, { endpoint: graphqlEndpoint() })
        services = (data.services ?? []).filter((s): s is Service => s !== null)
      } catch (e) {
        error = e instanceof Error ? e.message : "failed"
      } finally {
        loading = false
      }
    })()
  })
</script>

<h1>カタログ管理</h1>

<h2>サービス</h2>
{#if loading}
  <p>読み込み中...</p>
{:else if error}
  <p role="alert" class="error">{error}</p>
{:else}
  <table>
    <thead>
      <tr>
        <th scope="col">名前</th>
        <th scope="col">所要時間</th>
        <th scope="col">有効</th>
      </tr>
    </thead>
    <tbody>
      {#each services as service (service.id)}
        <tr>
          <td>{service.name}</td>
          <td>{service.durationMinutes} 分</td>
          <td>{service.enabled ? "✔" : "—"}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .error {
    color: #c00;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    padding: 0.5rem 1rem;
    border-bottom: 1px solid #ddd;
    text-align: left;
  }
</style>
