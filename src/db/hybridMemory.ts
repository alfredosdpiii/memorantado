import type Database from "better-sqlite3";
import { upsertLocalEmbedding } from "./embeddingStore.js";
import { createLocalExtractor } from "../memory/extractor.js";
import { runRetrievalEvaluation } from "../bench/memoryEvaluation.js";
import { semanticConflictReason } from "../memory/conflicts.js";
import type {
  CandidateMemory,
  Episode,
  MemoryConflict,
  SemanticMemory,
} from "../memory/types.js";
import { getMemorySources } from "./hybridRetrieval.js";
import {
  mapConflict,
  mapEpisode,
  mapMemory,
  MEMORY_WITH_LIFECYCLE_SELECT,
  normalizeScope,
  type EpisodeRow,
  type MemoryConflictRow,
  type SemanticMemoryRow,
} from "./hybridRows.js";
import {
  explainMemoryHistory,
  insertClaimVersion,
  insertMemoryEvidence,
  latestClaimVersionId,
  type MemoryExplanation,
} from "./temporalMemory.js";

export { retrieveContext } from "./hybridRetrieval.js";
export { runRetrievalEvaluation as runMemoryBenchmark };

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
      `INSERT INTO episodes (project, session, actor, role, content, source, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id, project, session, actor, role, content, source, metadata_json, created_at`
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
  if (opts.session) {
    return (
      db
        .prepare(
          `SELECT id, project, session, actor, role, content, source, metadata_json, created_at
           FROM episodes WHERE project = ? AND session = ?
           ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(project, opts.session, limit, offset) as EpisodeRow[]
    ).map(mapEpisode);
  }
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
  sourceEpisodeId?: number,
  evidence?: { quote?: string; spanStart?: number }
): SemanticMemory {
  const memory = db.transaction(() => {
    const existing = findActiveEquivalent(db, project, input);
    if (existing) {
      return reinforceMemory(db, existing, input, sourceEpisodeId, evidence);
    }
    const conflicting = findConflictingMemory(db, project, input);
    const inserted = insertSemanticMemory(db, project, input);
    const version = insertClaimVersion(db, inserted, input);
    if (sourceEpisodeId) {
      const quote = evidence?.quote ?? input.content;
      linkMemorySource(db, inserted.id, sourceEpisodeId, quote);
      insertMemoryEvidence(db, version, sourceEpisodeId, quote, evidence?.spanStart);
    }
    if (conflicting) {
      createConflict(db, project, inserted.id, conflicting.memory.id, conflicting.reason);
    }
    return inserted;
  })();
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
  return Promise.all(
    candidates.map((candidate) =>
      upsertSemanticMemory(db, project, candidate, episode.id, {
        quote: candidate.content,
        spanStart: episode.content.indexOf(candidate.content),
      })
    )
  );
}

export function listSemanticMemories(
  db: Database.Database,
  project: string,
  opts: {
    status?: string;
    lifecycleStatus?: "active" | "archived";
    limit?: number;
    offset?: number;
  } = {}
): SemanticMemory[] {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const clauses = ["sm.project = ?"];
  const params: Array<string | number> = [project];
  if (opts.status) {
    clauses.push("sm.status = ?");
    params.push(opts.status);
  }
  if (opts.lifecycleStatus) {
    clauses.push("COALESCE(ml.status, 'active') = ?");
    params.push(opts.lifecycleStatus);
  }
  params.push(limit, offset);
  return (
    db
      .prepare(
        `${MEMORY_WITH_LIFECYCLE_SELECT}
         WHERE ${clauses.join(" AND ")}
         ORDER BY sm.importance DESC, sm.updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params) as SemanticMemoryRow[]
  ).map(mapMemory);
}

export function setMemoryLifecycle(
  db: Database.Database,
  project: string,
  memoryId: number,
  status: "active" | "archived",
  reason?: string
): SemanticMemory | null {
  const exists = db
    .prepare("SELECT 1 FROM semantic_memories WHERE project = ? AND id = ?")
    .get(project, memoryId);
  if (!exists) return null;
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_lifecycle (memory_id, status, reason, archived_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET
       status = excluded.status,
       reason = excluded.reason,
       archived_at = excluded.archived_at,
       updated_at = excluded.updated_at`
  ).run(
    memoryId,
    status,
    status === "archived" ? reason?.trim() || null : null,
    status === "archived" ? timestamp : null,
    timestamp
  );
  return getMemory(db, project, memoryId);
}

export function explainMemory(
  db: Database.Database,
  project: string,
  memoryId: number
): MemoryExplanation {
  const memory = getMemory(db, project, memoryId);
  return explainMemoryHistory(
    db,
    project,
    memory,
    memory ? getMemorySources(db, memory.id) : []
  );
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
  status: "resolved" | "ignored" = "resolved",
  audit: {
    actor?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  } = {}
): MemoryConflict | null {
  return db.transaction(() => {
    const conflict = db
      .prepare("SELECT * FROM memory_conflicts WHERE project = ? AND id = ?")
      .get(project, conflictId) as MemoryConflictRow | undefined;
    if (!conflict) return null;
    if (status === "resolved") {
      const winnerId = resolvedMemoryId ?? conflict.memory_id;
      if (winnerId !== conflict.memory_id && winnerId !== conflict.conflicting_id) {
        throw new Error("resolved memory must belong to the conflict");
      }
      const loserId =
        winnerId === conflict.memory_id ? conflict.conflicting_id : conflict.memory_id;
      applyResolutionLifecycle(db, project, winnerId, loserId);
    }
    const row = db
      .prepare(
        `UPDATE memory_conflicts
         SET resolution_status = ?, resolved_memory_id = ?,
             resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE project = ? AND id = ? RETURNING *`
      )
      .get(status, resolvedMemoryId ?? null, project, conflictId) as MemoryConflictRow;
    db.prepare(
      `INSERT INTO conflict_resolution_events (
         conflict_id, project, action, resolved_memory_id, actor, reason, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      conflictId,
      project,
      status,
      resolvedMemoryId ?? null,
      audit.actor ?? null,
      audit.reason ?? null,
      audit.metadata ? JSON.stringify(audit.metadata) : null
    );
    return mapConflict(row);
  })();
}

function applyResolutionLifecycle(
  db: Database.Database,
  project: string,
  winnerId: number,
  loserId: number
): void {
  const timestamp = new Date().toISOString();
  db.prepare(
    `UPDATE semantic_memories
     SET status = 'active', supersedes_id = ?, updated_at = ?
     WHERE project = ? AND id = ?`
  ).run(loserId, timestamp, project, winnerId);
  db.prepare(
    `UPDATE semantic_memories
     SET status = 'superseded', updated_at = ?
     WHERE project = ? AND id = ?`
  ).run(timestamp, project, loserId);
  db.prepare(
    `UPDATE claim_versions
     SET status = 'superseded', retracted_at = COALESCE(retracted_at, ?)
     WHERE project = ? AND memory_id = ? AND status = 'active'`
  ).run(timestamp, project, loserId);
  db.prepare(
    `UPDATE claim_versions
     SET status = 'active', retracted_at = NULL
     WHERE id = (
       SELECT id FROM claim_versions WHERE project = ? AND memory_id = ?
       ORDER BY recorded_at DESC, id DESC LIMIT 1
     )`
  ).run(project, winnerId);
}
function reinforceMemory(
  db: Database.Database,
  existing: SemanticMemory,
  input: CandidateMemory,
  sourceEpisodeId?: number,
  evidence?: { quote?: string; spanStart?: number }
): SemanticMemory {
  const row = db
    .prepare(
      `UPDATE semantic_memories
       SET confidence = MIN(1.0, confidence + 0.05),
           importance = MAX(importance, ?),
           last_confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?
       RETURNING *`
    )
    .get(input.importance ?? existing.importance, existing.id) as SemanticMemoryRow;
  const memory = mapMemory(row);
  const version = insertClaimVersion(
    db,
    memory,
    input,
    latestClaimVersionId(db, memory.id)
  );
  if (sourceEpisodeId) {
    const quote = evidence?.quote ?? input.content;
    linkMemorySource(db, row.id, sourceEpisodeId, quote);
    insertMemoryEvidence(db, version, sourceEpisodeId, quote, evidence?.spanStart);
  }
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
      `${MEMORY_WITH_LIFECYCLE_SELECT}
       WHERE sm.project = ? AND sm.status = 'active'
         AND COALESCE(ml.status, 'active') = 'active'
         AND sm.subject = ? AND sm.predicate = ? AND sm.content = ?
       ORDER BY sm.updated_at DESC
       LIMIT 1`
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
): { memory: SemanticMemory; reason: string } | null {
  const predicate = input.predicate ?? "states";
  const rows = db
    .prepare(
      `${MEMORY_WITH_LIFECYCLE_SELECT}
       WHERE sm.project = ? AND sm.status = 'active'
         AND COALESCE(ml.status, 'active') = 'active'
         AND sm.subject = ? AND sm.predicate = ?
       ORDER BY sm.updated_at DESC`
    )
    .all(project, input.subject, predicate) as SemanticMemoryRow[];
  for (const row of rows) {
    const memory = mapMemory(row);
    const reason = semanticConflictReason(memory, input);
    if (reason) return { memory, reason };
  }
  return null;
}

function getMemory(
  db: Database.Database,
  project: string,
  id: number
): SemanticMemory | null {
  const row = db
    .prepare(`${MEMORY_WITH_LIFECYCLE_SELECT} WHERE sm.project = ? AND sm.id = ?`)
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
  conflictingId: number,
  reason: string
): void {
  db.prepare(
    `INSERT INTO memory_conflicts (project, memory_id, conflicting_id, reason)
     VALUES (?, ?, ?, ?)`
  ).run(project, memoryId, conflictingId, reason);
}

function upsertMemoryEmbedding(db: Database.Database, memory: SemanticMemory): void {
  upsertLocalEmbedding(db, "memory", memory.id, memory.content);
}
function upsertEpisodeEmbedding(db: Database.Database, episode: Episode): void {
  upsertLocalEmbedding(db, "episode", episode.id, episode.content);
}
