<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "../lib/api";
  import type { ContextPack, Episode, MemoryConflict, SemanticMemory } from "../lib/api";

  let { project }: { project: string } = $props();

  let episodes = $state<Episode[]>([]);
  let memories = $state<SemanticMemory[]>([]);
  let conflicts = $state<MemoryConflict[]>([]);
  let contextPack = $state<ContextPack | null>(null);
  let loading = $state(true);
  let episodeContent = $state("");
  let episodeActor = $state("");
  let query = $state("");
  let benchmarkReport = $state("");

  async function loadAll(currentProject = project) {
    loading = true;
    try {
      const [nextEpisodes, nextMemories, nextConflicts] = await Promise.all([
        api.getEpisodes(currentProject),
        api.getSemanticMemories(currentProject),
        api.getMemoryConflicts(currentProject),
      ]);
      episodes = nextEpisodes;
      memories = nextMemories;
      conflicts = nextConflicts;
    } finally {
      loading = false;
    }
  }

  async function appendEpisode() {
    if (!episodeContent.trim()) return;
    await api.createEpisode(project, {
      content: episodeContent,
      actor: episodeActor || undefined,
      extract: true,
    });
    episodeContent = "";
    episodeActor = "";
    await loadAll();
  }

  async function retrieve() {
    if (!query.trim()) return;
    contextPack = await api.retrieveContext(project, query);
  }

  async function runBenchmark() {
    const result = await api.runMemoryBenchmark(project);
    benchmarkReport = result.report;
    await loadAll();
  }

  onMount(() => {
    loadAll();
  });

  $effect(() => {
    loadAll(project);
  });
</script>

<div class="flex mb-4" style="justify-content: space-between; align-items: center;">
  <h1>Hybrid Memory</h1>
  <button onclick={runBenchmark}>Run benchmark</button>
</div>

<div class="card mb-4">
  <div class="card-title mb-4">Append Episode and Extract Memories</div>
  <div class="form-group">
    <label for="episode-actor">Actor</label>
    <input id="episode-actor" bind:value={episodeActor} placeholder="optional" />
  </div>
  <div class="form-group">
    <label for="episode-content">Episode</label>
    <textarea id="episode-content" rows="4" bind:value={episodeContent}></textarea>
  </div>
  <button class="primary" onclick={appendEpisode}>Append and Extract</button>
</div>

<div class="card mb-4">
  <div class="card-title mb-4">Retrieval Inspector</div>
  <div class="flex">
    <input
      class="flex-1"
      bind:value={query}
      placeholder="Ask for preferences, facts, provenance, or history..."
      onkeydown={(e) => {
        if (e.key === "Enter") retrieve();
      }}
    />
    <button onclick={retrieve}>Retrieve</button>
  </div>
  {#if contextPack}
    <div class="text-sm text-muted" style="margin-top: 8px;">
      Intent: {contextPack.intent}, tokens: {contextPack.estimatedTokens}, latency:
      {contextPack.latencyMs}ms
    </div>
    <pre>{contextPack.context}</pre>
  {/if}
</div>

{#if benchmarkReport}
  <div class="card mb-4">
    <div class="card-title">Latest Benchmark</div>
    <pre>{benchmarkReport}</pre>
  </div>
{/if}

{#if loading}
  <div class="empty">Loading...</div>
{:else}
  <div class="grid">
    <section class="card">
      <div class="card-title">Semantic Memories ({memories.length})</div>
      {#each memories as memory (memory.id)}
        <div class="item">
          <div>
            <span class="tag">{memory.kind}</span>
            <strong>{memory.subject}</strong>
            {memory.predicate}
          </div>
          <div>{memory.content}</div>
          <div class="text-sm text-muted">
            confidence {memory.confidence.toFixed(2)}, importance
            {memory.importance.toFixed(2)}
          </div>
        </div>
      {/each}
    </section>
    <section class="card">
      <div class="card-title">Episodes ({episodes.length})</div>
      {#each episodes as episode (episode.id)}
        <div class="item">
          <div class="text-sm text-muted">
            {new Date(episode.createdAt).toLocaleString()}
            {#if episode.actor}
              by {episode.actor}
            {/if}
          </div>
          <div>{episode.content}</div>
        </div>
      {/each}
    </section>
    <section class="card">
      <div class="card-title">Open Conflicts ({conflicts.length})</div>
      {#each conflicts as conflict (conflict.id)}
        <div class="item">
          <strong>#{conflict.id}</strong>
          memory {conflict.memoryId} conflicts with {conflict.conflictingId}
          <div class="text-sm text-muted">{conflict.reason}</div>
        </div>
      {/each}
    </section>
  </div>
{/if}

<style>
  .grid {
    display: grid;
    gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  }

  .item {
    border-top: 1px solid var(--border);
    padding: 12px 0;
  }

  pre {
    background: var(--bg);
    border-radius: 6px;
    overflow: auto;
    padding: 12px;
    white-space: pre-wrap;
  }
</style>
