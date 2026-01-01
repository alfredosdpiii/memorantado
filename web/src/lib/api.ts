const BASE = "";

export type GraphEntity = {
  name: string;
  entityType: string;
  observations: string[];
};

export type GraphRelation = {
  from: string;
  to: string;
  relationType: string;
};

export type MemoryItem = {
  id: number;
  project: string;
  kind: string;
  title: string | null;
  content: string;
  tags: string[];
  source: string | null;
  createdAt: string;
};

export type EntityDetail = GraphEntity & {
  id: number;
  relations: GraphRelation[];
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }

  return res.json();
}

export async function getProjects(): Promise<string[]> {
  const data = await request<{ projects: string[] }>("/api/projects");
  return data.projects;
}

export async function search(
  project: string,
  q: string
): Promise<{
  entities: GraphEntity[];
  relations: GraphRelation[];
  memoryItems: MemoryItem[];
}> {
  return request(`/api/search?project=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}`);
}

export async function getGraph(project: string): Promise<{
  entities: GraphEntity[];
  relations: GraphRelation[];
}> {
  return request(`/api/graph?project=${encodeURIComponent(project)}`);
}

export async function getEntity(project: string, name: string): Promise<EntityDetail> {
  return request(`/api/entity/${encodeURIComponent(name)}?project=${encodeURIComponent(project)}`);
}

export async function createEntity(
  project: string,
  name: string,
  entityType: string,
  observations?: string[]
): Promise<GraphEntity> {
  return request("/api/entity", {
    method: "POST",
    body: JSON.stringify({ project, name, entityType, observations }),
  });
}

export async function addObservation(
  project: string,
  entityName: string,
  content: string
): Promise<{ added: string[] }> {
  return request(`/api/entity/${encodeURIComponent(entityName)}/observations`, {
    method: "POST",
    body: JSON.stringify({ project, content }),
  });
}

export async function deleteObservation(id: number): Promise<void> {
  await request(`/api/observation/${id}`, { method: "DELETE" });
}

export async function createRelation(
  project: string,
  from: string,
  to: string,
  relationType: string
): Promise<{ id: number }> {
  return request("/api/relation", {
    method: "POST",
    body: JSON.stringify({ project, from, to, relationType }),
  });
}

export async function deleteRelation(id: number): Promise<void> {
  await request(`/api/relation/${id}`, { method: "DELETE" });
}

export async function getMemoryItems(
  project: string,
  opts: { q?: string; kind?: string; limit?: number; offset?: number } = {}
): Promise<MemoryItem[]> {
  const params = new URLSearchParams({ project });
  if (opts.q) params.set("q", opts.q);
  if (opts.kind) params.set("kind", opts.kind);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));

  return request(`/api/memory-items?${params}`);
}

export async function createMemoryItem(
  project: string,
  item: {
    kind: string;
    title?: string;
    content: string;
    tags?: string[];
    source?: string;
  }
): Promise<MemoryItem> {
  return request("/api/memory-items", {
    method: "POST",
    body: JSON.stringify({ project, ...item }),
  });
}

export async function deleteMemoryItem(project: string, id: number): Promise<void> {
  await request(`/api/memory-items/${id}?project=${encodeURIComponent(project)}`, {
    method: "DELETE",
  });
}
