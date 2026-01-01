<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "../lib/api";
  import type { MemoryItem } from "../lib/api";

  let { project }: { project: string } = $props();

  let items = $state<MemoryItem[]>([]);
  let loading = $state(true);
  let searchQuery = $state("");

  let showCreate = $state(false);
  let newKind = $state("note");
  let newTitle = $state("");
  let newContent = $state("");
  let newTags = $state("");

  async function loadItems() {
    loading = true;
    try {
      items = await api.getMemoryItems(project, { q: searchQuery || undefined, limit: 100 });
    } finally {
      loading = false;
    }
  }

  async function createItem() {
    if (!newContent.trim()) return;
    const tags = newTags.split(",").map((t) => t.trim()).filter(Boolean);
    await api.createMemoryItem(project, {
      kind: newKind,
      title: newTitle || undefined,
      content: newContent,
      tags: tags.length ? tags : undefined,
    });
    newKind = "note";
    newTitle = "";
    newContent = "";
    newTags = "";
    showCreate = false;
    loadItems();
  }

  async function deleteItem(id: number) {
    await api.deleteMemoryItem(project, id);
    loadItems();
  }

  function handleSearch(e: KeyboardEvent) {
    if (e.key === "Enter") loadItems();
  }

  onMount(() => {
    loadItems();
  });

  $effect(() => {
    project;
    loadItems();
  });
</script>

<div class="flex mb-4" style="justify-content: space-between; align-items: center;">
  <h1>Memory Items</h1>
  <button class="primary" onclick={() => showCreate = !showCreate}>
    {showCreate ? "Cancel" : "+ Memory"}
  </button>
</div>

{#if showCreate}
  <div class="card mb-4">
    <div class="card-title mb-4">Create Memory Item</div>
    <div class="form-group">
      <label for="kind">Kind</label>
      <select id="kind" bind:value={newKind}>
        <option value="note">note</option>
        <option value="decision">decision</option>
        <option value="snippet">snippet</option>
        <option value="log">log</option>
      </select>
    </div>
    <div class="form-group">
      <label for="title">Title (optional)</label>
      <input id="title" bind:value={newTitle} />
    </div>
    <div class="form-group">
      <label for="content">Content</label>
      <textarea id="content" rows="4" bind:value={newContent}></textarea>
    </div>
    <div class="form-group">
      <label for="tags">Tags (comma-separated)</label>
      <input id="tags" bind:value={newTags} placeholder="tag1, tag2" />
    </div>
    <button class="primary" onclick={createItem}>Create</button>
  </div>
{/if}

<div class="flex mb-4">
  <input
    type="text"
    placeholder="Search memory items..."
    bind:value={searchQuery}
    onkeydown={handleSearch}
    class="flex-1"
  />
  <button onclick={loadItems}>Search</button>
</div>

{#if loading}
  <div class="empty">Loading...</div>
{:else if items.length === 0}
  <div class="empty">No memory items yet. Create one to get started.</div>
{:else}
  {#each items as item}
    <div class="card">
      <div class="card-header">
        <div>
          <span class="tag">{item.kind}</span>
          {#if item.title}
            <strong>{item.title}</strong>
          {/if}
        </div>
        <button class="danger" onclick={() => deleteItem(item.id)}>Delete</button>
      </div>
      <div style="white-space: pre-wrap;">{item.content}</div>
      {#if item.tags.length}
        <div style="margin-top: 8px;">
          {#each item.tags as tag}
            <span class="tag">{tag}</span>
          {/each}
        </div>
      {/if}
      <div class="text-sm text-muted" style="margin-top: 8px;">
        {new Date(item.createdAt).toLocaleString()}
        {#if item.source}
          | Source: {item.source}
        {/if}
      </div>
    </div>
  {/each}
{/if}
