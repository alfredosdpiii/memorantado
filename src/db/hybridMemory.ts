import type Database from "better-sqlite3";
import { contentHash, embedText, embeddingDimension } from "../memory/localEmbedding.js";
import { createLocalExtractor } from "../memory/extractor.js";
import type {
  CandidateMemory,
  Episode,
  MemoryConflict,
  SemanticMemory,
} from "../memory/types.js";
import { getMemorySources, retrieveContext } from "./hybridRetrieval.js";
import {
  mapConflict,
  mapEpisode,
  mapMemory,
  normalizeScope,
  type EpisodeRow,
  type MemoryConflictRow,
  type SemanticMemoryRow,
} from "./hybridRows.js";

export { retrieveContext } from "./hybridRetrieval.js";

export type AppendEpisodeInput = {
  session?: string;
  actor?: string;
  role?: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
};

export function appendEpisode(
  db: Database.Database,
  project: string,
  input: AppendEpisodeInput
): Episode {
  const row = db
    .prepare(
      `
    INSERT INTO episodes (project, session, actor, role, content, source, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id, project, session, actor, role, content, source, metadata_json, created_at
  `
    )
    .get(
      project,
      input.session ?? null,
      input.actor ?? null,
      input.role ?? "user",
      input.content,
      input.source ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ) as EpisodeRow;
  const episode = mapEpisode(row);
  upsertEpisodeEmbedding(db, episode);
  return episode;
}

export function getEpisode(
  db: Database.Database,
  project: string,
  id: number
): Episode | null {
  const row = db
    .prepare(
      `
    SELECT id, project, session, actor, role, content, source, metadata_json, created_at
    FROM episodes
    WHERE project = ? AND id = ?
  `
    )
    .get(project, id) as EpisodeRow | undefined;
  return row ? mapEpisode(row) : null;
}

export function listEpisodes(
  db: Database.Database,
  project: string,
  opts: { limit?: number; offset?: number; session?: string } = {}
): Episode[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  if (opts.session)
    return listEpisodesBySession(db, project, opts.session, limit, offset);
  return (
    db
      .prepare(
        `
      SELECT id, project, session, actor, role, content, source, metadata_json, created_at
      FROM episodes
      WHERE project = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(project, limit, offset) as EpisodeRow[]
  ).map(mapEpisode);
}

export function upsertSemanticMemory(
  db: Database.Database,
  project: string,
  input: CandidateMemory,
  sourceEpisodeId?: number
): SemanticMemory {
  const existing = findActiveEquivalent(db, project, input);
  if (existing) return reinforceMemory(db, existing, input, sourceEpisodeId);
  const conflicting = findConflictingMemory(db, project, input);
  const memory = insertSemanticMemory(db, project, input);
  if (sourceEpisodeId) linkMemorySource(db, memory.id, sourceEpisodeId, input.content);
  if (conflicting) createConflict(db, project, memory.id, conflicting.id);
  upsertMemoryEmbedding(db, memory);
  return memory;
}

export async function extractMemories(
  db: Database.Database,
  project: string,
  episodeId: number
): Promise<SemanticMemory[]> {
  const episode = getEpisode(db, project, episodeId);
  if (!episode) return [];
  const candidates = await createLocalExtractor().extract(episode);
  return candidates.map((candidate) =>
    upsertSemanticMemory(db, project, candidate, episode.id)
  );
}

export function listSemanticMemories(
  db: Database.Database,
  project: string,
  opts: { status?: string; limit?: number; offset?: number } = {}
): SemanticMemory[] {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  if (opts.status)
    return listSemanticMemoriesByStatus(db, project, opts.status, limit, offset);
  return (
    db
      .prepare(
        `
      SELECT * FROM semantic_memories
      WHERE project = ?
      ORDER BY importance DESC, updated_at DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(project, limit, offset) as SemanticMemoryRow[]
  ).map(mapMemory);
}

export function explainMemory(
  db: Database.Database,
  project: string,
  memoryId: number
): { memory: SemanticMemory | null; sources: Episode[]; conflicts: MemoryConflict[] } {
  const memory = getMemory(db, project, memoryId);
  return {
    memory,
    sources: memory ? getMemorySources(db, memory.id) : [],
    conflicts: listConflicts(db, project).filter(
      (conflict) => conflict.memoryId === memoryId || conflict.conflictingId === memoryId
    ),
  };
}

export function listConflicts(
  db: Database.Database,
  project: string,
  status = "open"
): MemoryConflict[] {
  return (
    db
      .prepare(
        `
      SELECT * FROM memory_conflicts
      WHERE project = ? AND resolution_status = ?
      ORDER BY created_at DESC
    `
      )
      .all(project, status) as MemoryConflictRow[]
  ).map(mapConflict);
}

export function resolveConflict(
  db: Database.Database,
  project: string,
  conflictId: number,
  resolvedMemoryId?: number,
  status: "resolved" | "ignored" = "resolved"
): MemoryConflict | null {
  const row = db
    .prepare(
      `
    UPDATE memory_conflicts
    SET resolution_status = ?,
        resolved_memory_id = ?,
        resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE project = ? AND id = ?
    RETURNING *
  `
    )
    .get(status, resolvedMemoryId ?? null, project, conflictId) as
    | MemoryConflictRow
    | undefined;
  return row ? mapConflict(row) : null;
}

export async function runMemoryBenchmark(
  db: Database.Database,
  project: string
): Promise<{
  id: number;
  name: string;
  metrics: Record<string, number>;
  report: string;
}> {
  const fixtures = [
    {
      content: "Ada prefers SQLite for local agent memory. Ada uses MCP clients daily.",
      query: "What storage does Ada prefer?",
      expected: "sqlite",
    },
    {
      content: "The project decided to keep raw episodes for provenance.",
      query: "What does the project keep for provenance?",
      expected: "episodes",
    },
  ];
  let correct = 0;
  for (const fixture of fixtures) {
    const episode = appendEpisode(db, project, {
      actor: "benchmark",
      role: "system",
      content: fixture.content,
      source: "benchmark",
    });
    await extractMemories(db, project, episode.id);
    const result = retrieveContext(db, project, fixture.query, { limit: 3 });
    if (result.context.toLowerCase().includes(fixture.expected)) correct += 1;
  }
  const metrics = { accuracy: correct / fixtures.length, cases: fixtures.length };
  const report = `# Memory Benchmark\n\nAccuracy: ${correct}/${fixtures.length}\n`;
  const row = db
    .prepare(
      `
    INSERT INTO benchmark_runs (project, name, metrics_json, report)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `
    )
    .get(project, "local-fixtures", JSON.stringify(metrics), report) as { id: number };
  return { id: row.id, name: "local-fixtures", metrics, report };
}

function listEpisodesBySession(
  db: Database.Database,
  project: string,
  session: string,
  limit: number,
  offset: number
): Episode[] {
  return (
    db
      .prepare(
        `
      SELECT id, project, session, actor, role, content, source, metadata_json, created_at
      FROM episodes
      WHERE project = ? AND session = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(project, session, limit, offset) as EpisodeRow[]
  ).map(mapEpisode);
}

function listSemanticMemoriesByStatus(
  db: Database.Database,
  project: string,
  status: string,
  limit: number,
  offset: number
): SemanticMemory[] {
  return (
    db
      .prepare(
        `
      SELECT * FROM semantic_memories
      WHERE project = ? AND status = ?
      ORDER BY importance DESC, updated_at DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(project, status, limit, offset) as SemanticMemoryRow[]
  ).map(mapMemory);
}

function reinforceMemory(
  db: Database.Database,
  existing: SemanticMemory,
  input: CandidateMemory,
  sourceEpisodeId?: number
): SemanticMemory {
  const row = db
    .prepare(
      `
    UPDATE semantic_memories
    SET confidence = MIN(1.0, confidence + 0.05),
        importance = MAX(importance, ?),
        last_confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
    RETURNING *
  `
    )
    .get(input.importance ?? existing.importance, existing.id) as SemanticMemoryRow;
  if (sourceEpisodeId) linkMemorySource(db, row.id, sourceEpisodeId, input.content);
  const memory = mapMemory(row);
  upsertMemoryEmbedding(db, memory);
  return memory;
}

function insertSemanticMemory(
  db: Database.Database,
  project: string,
  input: CandidateMemory
): SemanticMemory {
  const row = db
    .prepare(
      `
    INSERT INTO semantic_memories (
      project, scope, kind, subject, predicate, object, content, confidence,
      importance, valid_from, valid_to, last_confirmed_at, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
    RETURNING *
  `
    )
    .get(
      project,
      normalizeScope(input.scope),
      input.kind ?? "fact",
      input.subject,
      input.predicate ?? "states",
      input.object ?? null,
      input.content,
      input.confidence ?? 0.65,
      input.importance ?? 0.5,
      input.validFrom ?? null,
      input.validTo ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ) as SemanticMemoryRow;
  return mapMemory(row);
}

function findActiveEquivalent(
  db: Database.Database,
  project: string,
  input: CandidateMemory
): SemanticMemory | null {
  const row = db
    .prepare(
      `
    SELECT * FROM semantic_memories
    WHERE project = ? AND status = 'active' AND subject = ? AND predicate = ? AND content = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `
    )
    .get(project, input.subject, input.predicate ?? "states", input.content) as
    | SemanticMemoryRow
    | undefined;
  return row ? mapMemory(row) : null;
}

function findConflictingMemory(
  db: Database.Database,
  project: string,
  input: CandidateMemory
): SemanticMemory | null {
  const row = db
    .prepare(
      `
    SELECT * FROM semantic_memories
    WHERE project = ? AND status = 'active' AND subject = ? AND predicate = ? AND content != ?
    ORDER BY updated_at DESC
    LIMIT 1
  `
    )
    .get(project, input.subject, input.predicate ?? "states", input.content) as
    | SemanticMemoryRow
    | undefined;
  return row ? mapMemory(row) : null;
}

function getMemory(
  db: Database.Database,
  project: string,
  id: number
): SemanticMemory | null {
  const row = db
    .prepare("SELECT * FROM semantic_memories WHERE project = ? AND id = ?")
    .get(project, id) as SemanticMemoryRow | undefined;
  return row ? mapMemory(row) : null;
}

function linkMemorySource(
  db: Database.Database,
  memoryId: number,
  episodeId: number,
  quote: string
): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO memory_sources (memory_id, episode_id, quote)
    VALUES (?, ?, ?)
  `
  ).run(memoryId, episodeId, quote);
}

function createConflict(
  db: Database.Database,
  project: string,
  memoryId: number,
  conflictingId: number
): void {
  db.prepare(
    `
    INSERT INTO memory_conflicts (project, memory_id, conflicting_id, reason)
    VALUES (?, ?, ?, ?)
  `
  ).run(
    project,
    memoryId,
    conflictingId,
    "same subject and predicate with different content"
  );
}

function upsertMemoryEmbedding(db: Database.Database, memory: SemanticMemory): void {
  const vector = embedText(memory.content);
  db.prepare(
    `
    INSERT INTO memory_embeddings (memory_id, provider, dimension, vector_json, content_hash)
    VALUES (?, 'local-hash', ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      vector_json = excluded.vector_json,
      content_hash = excluded.content_hash,
      created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `
  ).run(
    memory.id,
    embeddingDimension(),
    JSON.stringify(vector),
    contentHash(memory.content)
  );
}

function upsertEpisodeEmbedding(db: Database.Database, episode: Episode): void {
  const vector = embedText(episode.content);
  db.prepare(
    `
    INSERT INTO episode_embeddings (episode_id, provider, dimension, vector_json, content_hash)
    VALUES (?, 'local-hash', ?, ?, ?)
    ON CONFLICT(episode_id) DO UPDATE SET
      vector_json = excluded.vector_json,
      content_hash = excluded.content_hash,
      created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `
  ).run(
    episode.id,
    embeddingDimension(),
    JSON.stringify(vector),
    contentHash(episode.content)
  );
}
