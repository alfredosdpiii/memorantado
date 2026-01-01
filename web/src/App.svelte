<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./lib/api";
  import Search from "./routes/Search.svelte";
  import Entity from "./routes/Entity.svelte";
  import MemoryItems from "./routes/MemoryItems.svelte";
  import Graph from "./routes/Graph.svelte";

  let route = $state(window.location.hash || "#/");
  let project = $state(localStorage.getItem("memorantado_project") || "global");
  let projects = $state<string[]>(["global"]);

  function navigate(hash: string) {
    window.location.hash = hash;
    route = hash;
  }

  function updateProject(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    project = value;
    localStorage.setItem("memorantado_project", value);
  }

  onMount(() => {
    window.addEventListener("hashchange", () => {
      route = window.location.hash || "#/";
    });

    api.getProjects().then((p) => {
      if (p.length && !p.includes(project)) {
        projects = [...p, project].sort();
      } else if (p.length) {
        projects = p;
      }
    });
  });

  const isActive = (path: string) => route.startsWith(path);
</script>

<nav>
  <span class="brand">memorantado</span>
  <a href="#/" class:active={route === "#/"} onclick={(e) => { e.preventDefault(); navigate("#/"); }}>Search</a>
  <a href="#/graph" class:active={isActive("#/graph")} onclick={(e) => { e.preventDefault(); navigate("#/graph"); }}>Graph</a>
  <a href="#/memory" class:active={isActive("#/memory")} onclick={(e) => { e.preventDefault(); navigate("#/memory"); }}>Memory</a>

  <div class="project-select">
    <label for="project-select">Project:</label>
    <select id="project-select" value={project} onchange={updateProject}>
      {#each projects as p}
        <option value={p}>{p}</option>
      {/each}
    </select>
  </div>
</nav>

<main class="container">
  {#if route === "#/"}
    <Search {project} {navigate} />
  {:else if route === "#/graph"}
    <Graph {project} {navigate} />
  {:else if route.startsWith("#/entity/")}
    <Entity {project} name={decodeURIComponent(route.slice(9))} />
  {:else if route.startsWith("#/memory")}
    <MemoryItems {project} />
  {:else}
    <div class="empty">Page not found</div>
  {/if}
</main>
