<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "../lib/api";
  import type { EntityDetail } from "../lib/api";

  let { project, name }: { project: string; name: string } = $props();

  let entity = $state<EntityDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let newObservation = $state("");
  let showAddRelation = $state(false);
  let relTo = $state("");
  let relType = $state("");

  async function loadEntity() {
    loading = true;
    error = null;
    try {
      entity = await api.getEntity(project, name);
    } catch (e) {
      error = "Entity not found";
      entity = null;
    } finally {
      loading = false;
    }
  }

  async function addObservation() {
    if (!newObservation.trim()) return;
    await api.addObservation(project, name, newObservation);
    newObservation = "";
    loadEntity();
  }

  async function createRelation() {
    if (!relTo.trim() || !relType.trim()) return;
    await api.createRelation(project, name, relTo, relType);
    relTo = "";
    relType = "";
    showAddRelation = false;
    loadEntity();
  }

  onMount(() => {
    loadEntity();
  });

  $effect(() => {
    name;
    project;
    loadEntity();
  });
</script>

{#if loading}
  <div class="empty">Loading...</div>
{:else if error}
  <div class="empty">{error}</div>
{:else if entity}
  <div class="flex mb-4" style="justify-content: space-between; align-items: center;">
    <div>
      <h1>{entity.name}</h1>
      <span class="tag">{entity.entityType}</span>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <span class="card-title">Observations ({entity.observations.length})</span>
    </div>

    {#if entity.observations.length === 0}
      <div class="text-muted mb-4">No observations yet</div>
    {:else}
      {#each entity.observations as obs, i}
        <div style="padding: 8px 0; border-bottom: 1px solid var(--border);">
          {obs}
        </div>
      {/each}
    {/if}

    <div class="flex" style="margin-top: 12px;">
      <input
        placeholder="Add observation..."
        bind:value={newObservation}
        class="flex-1"
        onkeydown={(e) => e.key === "Enter" && addObservation()}
      />
      <button class="primary" onclick={addObservation}>Add</button>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <span class="card-title">Relations ({entity.relations.length})</span>
      <button onclick={() => showAddRelation = !showAddRelation}>
        {showAddRelation ? "Cancel" : "+ Relation"}
      </button>
    </div>

    {#if showAddRelation}
      <div class="flex mb-4">
        <span style="padding: 8px;">{name} --</span>
        <input placeholder="relation type" bind:value={relType} style="width: 150px;" />
        <span style="padding: 8px;">--></span>
        <input placeholder="target entity" bind:value={relTo} class="flex-1" />
        <button class="primary" onclick={createRelation}>Create</button>
      </div>
    {/if}

    {#if entity.relations.length === 0}
      <div class="text-muted">No relations</div>
    {:else}
      {#each entity.relations as rel}
        <div style="padding: 8px 0; border-bottom: 1px solid var(--border);">
          {#if rel.from === name}
            <span class="text-muted">{name}</span>
            <span> -- {rel.relationType} --> </span>
            <a href="#/entity/{encodeURIComponent(rel.to)}">{rel.to}</a>
          {:else}
            <a href="#/entity/{encodeURIComponent(rel.from)}">{rel.from}</a>
            <span> -- {rel.relationType} --> </span>
            <span class="text-muted">{name}</span>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
{/if}
