import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MemoryStore } from "../db/store.js";

export type WikiBuildResult = {
  project: string;
  root: string;
  revision: string;
  files: string[];
};

type GeneratedFile = {
  path: string;
  content: string;
};

export async function buildObsidianWiki(
  store: MemoryStore,
  project: string,
  vaultRoot: string
): Promise<WikiBuildResult> {
  const root = path.resolve(vaultRoot, "Memorantado Generated");
  const generatedAt = new Date().toISOString();
  const files = await renderWiki(store, project, generatedAt);
  const revision = createHash("sha256")
    .update(
      files
        .map((file) => `${file.path}\0${file.content.replace(/^generatedAt: .*$/m, "")}`)
        .join("\0")
    )
    .digest("hex");
  const staging = `${root}.tmp-${process.pid}`;
  fs.rmSync(staging, { force: true, recursive: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const file of files) {
    const destination = path.join(staging, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content);
  }
  const manifest = {
    format: "memorantado-obsidian",
    version: 1,
    project,
    revision,
    generatedAt,
    files: files.map((file) => file.path),
  };
  fs.writeFileSync(
    path.join(staging, ".memorantado-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  const backup = `${root}.previous-${process.pid}`;
  fs.rmSync(backup, { force: true, recursive: true });
  if (fs.existsSync(root)) fs.renameSync(root, backup);
  try {
    fs.renameSync(staging, root);
    fs.rmSync(backup, { force: true, recursive: true });
  } catch (error) {
    if (fs.existsSync(backup) && !fs.existsSync(root)) fs.renameSync(backup, root);
    fs.rmSync(staging, { force: true, recursive: true });
    throw error;
  }
  await store.replaceWikiProjectionState(
    project,
    files.map((file) => ({
      path: file.path,
      revision,
      contentHash: sha256(file.content),
      generatedAt,
    }))
  );
  return { project, root, revision, files: files.map((file) => file.path) };
}

async function renderWiki(
  store: MemoryStore,
  project: string,
  generatedAt: string
): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  const memories = (await store.listSemanticMemories(project, { limit: 100_000 })).sort(
    (left, right) => left.id - right.id
  );
  const episodes = (await store.listEpisodes(project, { limit: 100_000 })).sort(
    (left, right) => left.id - right.id
  );
  const conflicts = (
    await Promise.all(
      ["open", "resolved", "ignored"].map((status) =>
        store.listConflicts(project, status)
      )
    )
  )
    .flat()
    .sort((left, right) => left.id - right.id);
  const memoryItems = (await store.listMemoryItems(project, { limit: 100_000 })).sort(
    (left, right) => left.id - right.id
  );
  const knowledge = await store.readGraph(project);
  const entitySlugs = uniqueSlugs(knowledge.entities.map((entity) => entity.name));

  for (const memory of memories) {
    const explanation = await store.explainMemory(project, memory.id);
    const sourceLinks = explanation.sources.map(
      (source) => `[[Sources/episode-${source.id}|episode ${source.id}]]`
    );
    files.push({
      path: `Memories/memory-${memory.id}.md`,
      content: page(
        {
          id: `memory-${memory.id}`,
          type: "semantic_memory",
          project,
          revision: `${memory.id}:${memory.updatedAt}`,
          generatedAt,
          status: memory.status,
          kind: memory.kind,
          subject: memory.subject,
        },
        `Memory ${memory.id}: ${memory.subject}`,
        [
          memory.content,
          "## Claim",
          `- Subject: ${memory.subject}`,
          `- Predicate: ${memory.predicate}`,
          `- Object: ${memory.object ?? ""}`,
          `- Confidence: ${memory.confidence}`,
          `- Importance: ${memory.importance}`,
          `- Valid from: ${memory.validFrom ?? ""}`,
          `- Valid to: ${memory.validTo ?? ""}`,
          "## Sources",
          ...(sourceLinks.length ? sourceLinks.map((link) => `- ${link}`) : ["- None"]),
          "## History",
          ...explanation.versions.map(
            (version) =>
              `- ${version.recordedAt} — ${version.status} — ${version.content} (claim-version:${version.id})`
          ),
        ]
      ),
    });
  }

  for (const episode of episodes) {
    files.push({
      path: `Sources/episode-${episode.id}.md`,
      content: page(
        {
          id: `episode-${episode.id}`,
          type: "episode",
          project,
          revision: `${episode.id}:${episode.createdAt}`,
          generatedAt,
          actor: episode.actor,
          source: episode.source,
        },
        `Episode ${episode.id}`,
        [
          episode.content,
          `- Created: ${episode.createdAt}`,
          `- Session: ${episode.session ?? ""}`,
        ]
      ),
    });
  }

  for (const conflict of conflicts) {
    files.push({
      path: `Conflicts/conflict-${conflict.id}.md`,
      content: page(
        {
          id: `conflict-${conflict.id}`,
          type: "memory_conflict",
          project,
          revision: `${conflict.id}:${conflict.resolvedAt ?? conflict.createdAt}`,
          generatedAt,
          status: conflict.resolutionStatus,
        },
        `Conflict ${conflict.id}`,
        [
          conflict.reason,
          `- Memory: [[Memories/memory-${conflict.memoryId}|memory ${conflict.memoryId}]]`,
          `- Conflicting: [[Memories/memory-${conflict.conflictingId}|memory ${conflict.conflictingId}]]`,
          `- Resolved memory: ${conflict.resolvedMemoryId ? `[[Memories/memory-${conflict.resolvedMemoryId}|memory ${conflict.resolvedMemoryId}]]` : ""}`,
        ]
      ),
    });
  }

  for (const entity of knowledge.entities.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const slug = entitySlugs.get(entity.name) ?? "entity";
    const relations = knowledge.relations.filter(
      (relation) => relation.from === entity.name || relation.to === entity.name
    );
    files.push({
      path: `Entities/${slug}.md`,
      content: page(
        {
          id: `entity-${slug}`,
          type: "entity",
          project,
          revision: sha256(JSON.stringify({ entity, relations })),
          generatedAt,
          entityType: entity.entityType,
        },
        entity.name,
        [
          "## Observations",
          ...(entity.observations.length
            ? entity.observations.map((observation) => `- ${observation}`)
            : ["- None"]),
          "## Relations",
          ...(relations.length
            ? relations.map(
                (relation) =>
                  `- ${relation.from} — ${relation.relationType} → ${relation.to}`
              )
            : ["- None"]),
        ]
      ),
    });
  }

  for (const item of memoryItems) {
    files.push({
      path: `Timeline/item-${item.id}.md`,
      content: page(
        {
          id: `timeline-${item.id}`,
          type: "memory_item",
          project,
          revision: `${item.id}:${item.createdAt}`,
          generatedAt,
          kind: item.kind,
        },
        item.title ?? `Timeline item ${item.id}`,
        [item.content, `- Created: ${item.createdAt}`, `- Tags: ${item.tags.join(", ")}`]
      ),
    });
  }

  files.push({
    path: "Index.md",
    content: page(
      {
        id: "index",
        type: "index",
        project,
        revision: sha256(
          JSON.stringify({
            memories: memories.map((memory) => memory.id),
            episodes: episodes.map((episode) => episode.id),
            conflicts: conflicts.map((conflict) => conflict.id),
            entities: knowledge.entities.map((entity) => entity.name),
            memoryItems: memoryItems.map((item) => item.id),
          })
        ),
        generatedAt,
      },
      `Memorantado: ${project}`,
      [
        `- Memories: ${memories.length}`,
        `- Sources: ${episodes.length}`,
        `- Conflicts: ${conflicts.length}`,
        `- Entities: ${knowledge.entities.length}`,
        `- Timeline items: ${memoryItems.length}`,
        "## Views",
        "- [[Memories.base|Memory table]]",
        "- [[Timeline/Index|Timeline]]",
      ]
    ),
  });
  files.push({
    path: "Timeline/Index.md",
    content: page(
      {
        id: "timeline-index",
        type: "index",
        project,
        revision: sha256(JSON.stringify(memoryItems)),
        generatedAt,
      },
      "Timeline",
      memoryItems.map(
        (item) => `- [[Timeline/item-${item.id}|${item.title ?? `Item ${item.id}`}]]`
      )
    ),
  });
  files.push({
    path: "Memories.base",
    content:
      'filters:\n  and:\n    - file.inFolder("Memorantado Generated/Memories")\nviews:\n  - type: table\n    name: Active memories\n    filters:\n      and:\n        - status == "active"\n    order:\n      - file.name\n      - kind\n      - subject\n      - status\n',
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function page(
  properties: Record<string, string | number | null>,
  title: string,
  sections: string[]
): string {
  const frontmatter = Object.entries(properties)
    .map(([key, value]) => `${key}: ${yaml(value)}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n# ${title}\n\n${sections.join("\n")}\n`;
}

function yaml(value: string | number | null): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function uniqueSlugs(names: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const name of [...names].sort()) {
    const base =
      name
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase() || "entity";
    let slug = base;
    let suffix = 2;
    while (used.has(slug)) slug = `${base}-${suffix++}`;
    used.add(slug);
    result.set(name, slug);
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
