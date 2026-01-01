<script lang="ts">
  import * as api from "../lib/api";
  import type { GraphEntity, MemoryItem } from "../lib/api";

  let { project, navigate }: { project: string; navigate: (hash: string) => void } = $props();

  let query = $state("");
  let entities = $state<GraphEntity[]>([]);
  let memoryItems = $state<MemoryItem[]>([]);
  let loading = $state(false);
  let searched = $state(false);

  async function doSearch() {
    if (!query.trim()) return;
    loading = true;
    searched = true;
    try {
      const result = await api.search(project, query);
      entities = result.entities;
      memoryItems = result.memoryItems;
    } finally {
      loading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") doSearch();
  }
</script>

<h1 class="mb-4">Search</h1>

<div class="flex mb-4">
  <input
    type="text"
    placeholder="Search entities and memories..."
    bind:value={query}
    onkeydown={handleKeydown}
    class="flex-1"
  />
  <button class="primary" onclick={doSearch} disabled={loading}>
    {loading ? "..." : "Search"}
  </button>
</div>

{#if searched}
  <div class="card">
    <div class="card-header">
      <span class="card-title">Entities ({entities.length})</span>
    </div>
    {#if entities.length === 0}
      <div class="text-muted">No entities found</div>
    {:else}
      {#each entities as entity}
        <div style="padding: 8px 0; border-bottom: 1px solid var(--border);">
          <a href="#/entity/{encodeURIComponent(entity.name)}" onclick={(e) => { e.preventDefault(); navigate(`#/entity/${encodeURIComponent(entity.name)}`); }}>
            {entity.name}
          </a>
          <span class="tag">{entity.entityType}</span>
          {#if entity.observations.length}
            <div class="text-sm text-muted" style="margin-top: 4px;">
              {entity.observations.slice(0, 2).join(" | ")}
              {#if entity.observations.length > 2}...{/if}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <div class="card">
    <div class="card-header">
      <span class="card-title">Memory Items ({memoryItems.length})</span>
    </div>
    {#if memoryItems.length === 0}
      <div class="text-muted">No memory items found</div>
    {:else}
      {#each memoryItems as item}
        <div style="padding: 8px 0; border-bottom: 1px solid var(--border);">
          <div>
            <span class="tag">{item.kind}</span>
            {#if item.title}
              <strong>{item.title}</strong>
            {/if}
          </div>
          <div class="text-sm" style="margin-top: 4px;">
            {item.content.slice(0, 150)}{item.content.length > 150 ? "..." : ""}
          </div>
          <div class="text-sm text-muted" style="margin-top: 4px;">
            {new Date(item.createdAt).toLocaleString()}
          </div>
        </div>
      {/each}
    {/if}
  </div>
{:else}
  <div class="empty">Enter a search query above</div>
{/if}
