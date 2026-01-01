<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "../lib/api";
  import type { GraphEntity, GraphRelation } from "../lib/api";

  let { project, navigate }: { project: string; navigate: (hash: string) => void } = $props();

  let entities = $state<GraphEntity[]>([]);
  let relations = $state<GraphRelation[]>([]);
  let loading = $state(true);

  let showCreateEntity = $state(false);
  let newEntityName = $state("");
  let newEntityType = $state("");

  async function loadGraph() {
    loading = true;
    try {
      const result = await api.getGraph(project);
      entities = result.entities;
      relations = result.relations;
    } finally {
      loading = false;
    }
  }

  async function createEntity() {
    if (!newEntityName.trim() || !newEntityType.trim()) return;
    await api.createEntity(project, newEntityName, newEntityType);
    newEntityName = "";
    newEntityType = "";
    showCreateEntity = false;
    loadGraph();
  }

  onMount(() => {
    loadGraph();
  });

  $effect(() => {
    project;
    loadGraph();
  });
</script>

<div class="flex mb-4" style="justify-content: space-between; align-items: center;">
  <h1>Graph</h1>
  <button class="primary" onclick={() => showCreateEntity = !showCreateEntity}>
    {showCreateEntity ? "Cancel" : "+ Entity"}
  </button>
</div>

{#if showCreateEntity}
  <div class="card mb-4">
    <div class="card-title mb-4">Create Entity</div>
    <div class="flex">
      <input placeholder="Name" bind:value={newEntityName} class="flex-1" />
      <input placeholder="Type (e.g. person, project)" bind:value={newEntityType} class="flex-1" />
      <button class="primary" onclick={createEntity}>Create</button>
    </div>
  </div>
{/if}

{#if loading}
  <div class="empty">Loading...</div>
{:else if entities.length === 0}
  <div class="empty">No entities yet. Create one to get started.</div>
{:else}
  <div class="card">
    <div class="card-header">
      <span class="card-title">Entities ({entities.length})</span>
    </div>
    {#each entities as entity}
      <div style="padding: 8px 0; border-bottom: 1px solid var(--border);">
        <a href="#/entity/{encodeURIComponent(entity.name)}" onclick={(e) => { e.preventDefault(); navigate(`#/entity/${encodeURIComponent(entity.name)}`); }}>
          {entity.name}
        </a>
        <span class="tag">{entity.entityType}</span>
        <span class="text-sm text-muted">({entity.observations.length} observations)</span>
      </div>
    {/each}
  </div>

  <div class="card">
    <div class="card-header">
      <span class="card-title">Relations ({relations.length})</span>
    </div>
    {#if relations.length === 0}
      <div class="text-muted">No relations</div>
    {:else}
      {#each relations as rel}
        <div style="padding: 8px 0; border-bottom: 1px solid var(--border);">
          <a href="#/entity/{encodeURIComponent(rel.from)}" onclick={(e) => { e.preventDefault(); navigate(`#/entity/${encodeURIComponent(rel.from)}`); }}>
            {rel.from}
          </a>
          <span class="text-muted"> -- {rel.relationType} --> </span>
          <a href="#/entity/{encodeURIComponent(rel.to)}" onclick={(e) => { e.preventDefault(); navigate(`#/entity/${encodeURIComponent(rel.to)}`); }}>
            {rel.to}
          </a>
        </div>
      {/each}
    {/if}
  </div>
{/if}
