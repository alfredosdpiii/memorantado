import type Database from "better-sqlite3";
import { cosineSimilarity, embedText } from "../memory/localEmbedding.js";
import type {
  ContextPack,
  Episode,
  MemoryConflict,
  RetrievalHit,
} from "../memory/types.js";
import {
  estimateTokens,
  ftsQuery,
  inferIntent,
  mapConflict,
  mapEpisode,
  mapMemory,
  overlapScore,
  type EpisodeRow,
  type MemoryConflictRow,
  type SemanticMemoryRow,
} from "./hybridRows.js";

type RetrievalOptions = {
  limit?: number;
  tokenBudget?: number;
};

const DEFAULT_LIMIT = 8;
const DEFAULT_TOKEN_BUDGET = 1800;
const MAX_RETRIEVAL_SCAN = 5000;

export function retrieveContext(
  db: Database.Database,
  project: string,
  query: string,
  opts: RetrievalOptions = {}
): ContextPack {
  const start = Date.now();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const memories = collectMemoryHits(db, project, query, limit * 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const episodes = collectEpisodeHits(db, project, query, limit * 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const conflicts = listOpenConflictsForHits(db, project, memories);
  const context = renderContext(memories, episodes, conflicts, tokenBudget);
  const pack: ContextPack = {
    query,
    intent: inferIntent(query),
    memories,
    episodes,
    conflicts,
    context,
    tokenBudget,
    estimatedTokens: estimateTokens(context),
    latencyMs: Date.now() - start,
  };
  logAccess(db, project, pack);
  return pack;
}

export function getMemorySources(db: Database.Database, memoryId: number): Episode[] {
  return (
    db
      .prepare(
        `
      SELECT e.id, e.project, e.session, e.actor, e.role, e.content, e.source,
             e.metadata_json, e.created_at
      FROM memory_sources ms
      JOIN episodes e ON e.id = ms.episode_id
      WHERE ms.memory_id = ?
      ORDER BY e.created_at DESC
      LIMIT 5
    `
      )
      .all(memoryId) as EpisodeRow[]
  ).map(mapEpisode);
}

function collectMemoryHits(
  db: Database.Database,
  project: string,
  query: string,
  limit: number
): RetrievalHit[] {
  const queryVector = embedText(query);
  const ftsIds = new Set(searchMemoryFts(db, project, query, limit * 2));
  return listActiveMemories(db, project, MAX_RETRIEVAL_SCAN)
    .map((memory) => {
      const vector = readVector(db, "memory_embeddings", "memory_id", memory.id);
      const scoreParts = {
        fts: ftsIds.has(memory.id) ? 1 : 0,
        vector: vector ? cosineSimilarity(queryVector, vector) : 0,
        overlap: overlapScore(query, memory.content),
        importance: memory.importance,
        confidence: memory.confidence,
        recency: recencyScore(memory.updatedAt),
      };
      return {
        type: "memory" as const,
        id: memory.id,
        memory,
        sources: getMemorySources(db, memory.id),
        score: weighted(scoreParts),
        scoreParts,
      };
    })
    .filter((hit) => hit.score > 0.1);
}

function collectEpisodeHits(
  db: Database.Database,
  project: string,
  query: string,
  limit: number
): RetrievalHit[] {
  const queryVector = embedText(query);
  const ftsIds = new Set(searchEpisodeFts(db, project, query, limit * 2));
  return listRecentEpisodes(db, project, MAX_RETRIEVAL_SCAN)
    .map((episode) => {
      const vector = readVector(db, "episode_embeddings", "episode_id", episode.id);
      const scoreParts = {
        fts: ftsIds.has(episode.id) ? 1 : 0,
        vector: vector ? cosineSimilarity(queryVector, vector) : 0,
        overlap: overlapScore(query, episode.content),
        recency: recencyScore(episode.createdAt),
      };
      return {
        type: "episode" as const,
        id: episode.id,
        episode,
        score: weighted(scoreParts),
        scoreParts,
      };
    })
    .filter((hit) => hit.score > 0.1);
}

function listActiveMemories(
  db: Database.Database,
  project: string,
  limit: number
): ReturnType<typeof mapMemory>[] {
  return (
    db
      .prepare(
        `
      SELECT * FROM semantic_memories
      WHERE project = ? AND status = 'active'
      ORDER BY importance DESC, updated_at DESC
      LIMIT ?
    `
      )
      .all(project, limit) as SemanticMemoryRow[]
  ).map(mapMemory);
}

function listRecentEpisodes(
  db: Database.Database,
  project: string,
  limit: number
): Episode[] {
  return (
    db
      .prepare(
        `
      SELECT id, project, session, actor, role, content, source, metadata_json, created_at
      FROM episodes
      WHERE project = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `
      )
      .all(project, limit) as EpisodeRow[]
  ).map(mapEpisode);
}

function searchMemoryFts(
  db: Database.Database,
  project: string,
  query: string,
  limit: number
): number[] {
  const match = ftsQuery(query);
  if (!match) return [];
  return (
    db
      .prepare(
        `
      SELECT sm.id
      FROM semantic_memories_fts f
      JOIN semantic_memories sm ON sm.id = f.rowid
      WHERE f.project = ? AND sm.status = 'active' AND semantic_memories_fts MATCH ?
      LIMIT ?
    `
      )
      .all(project, match, limit) as Array<{ id: number }>
  ).map((row) => row.id);
}

function searchEpisodeFts(
  db: Database.Database,
  project: string,
  query: string,
  limit: number
): number[] {
  const match = ftsQuery(query);
  if (!match) return [];
  return (
    db
      .prepare(
        `
      SELECT e.id
      FROM episodes_fts f
      JOIN episodes e ON e.id = f.rowid
      WHERE f.project = ? AND episodes_fts MATCH ?
      LIMIT ?
    `
      )
      .all(project, match, limit) as Array<{ id: number }>
  ).map((row) => row.id);
}

function readVector(
  db: Database.Database,
  table: "memory_embeddings" | "episode_embeddings",
  column: "memory_id" | "episode_id",
  id: number
): number[] | null {
  const row = db
    .prepare(`SELECT vector_json FROM ${table} WHERE ${column} = ?`)
    .get(id) as { vector_json: string } | undefined;
  return row ? (JSON.parse(row.vector_json) as number[]) : null;
}

function listOpenConflictsForHits(
  db: Database.Database,
  project: string,
  hits: RetrievalHit[]
): MemoryConflict[] {
  const ids = hits.map((hit) => hit.id);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return (
    db
      .prepare(
        `
      SELECT * FROM memory_conflicts
      WHERE project = ? AND resolution_status = 'open'
        AND (memory_id IN (${placeholders}) OR conflicting_id IN (${placeholders}))
      ORDER BY created_at DESC
    `
      )
      .all(project, ...ids, ...ids) as MemoryConflictRow[]
  ).map(mapConflict);
}

function recencyScore(isoDate: string): number {
  const ageMs = Math.max(0, Date.now() - Date.parse(isoDate));
  return 1 / (1 + ageMs / 86_400_000 / 30);
}

function weighted(parts: Record<string, number>): number {
  return (
    (parts.fts ?? 0) * 0.22 +
    (parts.vector ?? 0) * 0.24 +
    (parts.overlap ?? 0) * 0.18 +
    (parts.importance ?? 0) * 0.14 +
    (parts.confidence ?? 0) * 0.12 +
    (parts.recency ?? 0) * 0.1
  );
}

function renderContext(
  memories: RetrievalHit[],
  episodes: RetrievalHit[],
  conflicts: MemoryConflict[],
  tokenBudget: number
): string {
  const lines = ["# Retrieved Memory Context"];
  for (const hit of memories) pushMemoryLines(lines, hit);
  for (const hit of episodes) pushEpisodeLine(lines, hit);
  for (const conflict of conflicts) {
    lines.push(
      `- [conflict:${conflict.id}] memory ${conflict.memoryId} conflicts with ${conflict.conflictingId}`
    );
  }
  return linesWithinBudget(lines, tokenBudget).join("\n");
}

function pushMemoryLines(lines: string[], hit: RetrievalHit): void {
  if (!hit.memory) return;
  lines.push(`- [memory:${hit.id} score=${hit.score.toFixed(3)}] ${hit.memory.content}`);
  for (const source of hit.sources ?? []) {
    lines.push(`  source episode:${source.id} ${source.content.slice(0, 180)}`);
  }
}

function pushEpisodeLine(lines: string[], hit: RetrievalHit): void {
  if (!hit.episode) return;
  lines.push(
    `- [episode:${hit.id} score=${hit.score.toFixed(3)}] ${hit.episode.content}`
  );
}

function linesWithinBudget(lines: string[], tokenBudget: number): string[] {
  const output: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    tokens += estimateTokens(line);
    if (tokens > tokenBudget) break;
    output.push(line);
  }
  return output;
}

function logAccess(db: Database.Database, project: string, pack: ContextPack): void {
  db.prepare(
    `
    INSERT INTO memory_access_log (project, query, intent, result_json, latency_ms)
    VALUES (?, ?, ?, ?, ?)
  `
  ).run(
    project,
    pack.query,
    pack.intent,
    JSON.stringify({
      memoryIds: pack.memories.map((hit) => hit.id),
      episodeIds: pack.episodes.map((hit) => hit.id),
      estimatedTokens: pack.estimatedTokens,
    }),
    pack.latencyMs
  );
}
