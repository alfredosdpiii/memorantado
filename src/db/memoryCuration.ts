import type Database from "better-sqlite3";
import { contentHash } from "../memory/localEmbedding.js";
import { normalizeRepoSource, normalizeTags } from "../memory/tags.js";
import type {
  EvidenceInput,
  FileSnapshot,
  MemoryConflict,
  SemanticMemory,
  StaleFileEvidence,
} from "../memory/types.js";
import { appendEpisode, attachEvidence, getEpisode, getMemory } from "./hybridMemory.js";
import { createConflict } from "./memoryConflicts.js";
import {
  semanticListClauses,
  semanticListOrder,
  type SemanticMemoryListOptions,
} from "./memoryRules.js";
import {
  mapClaimVersion,
  mapMemory,
  MEMORY_WITH_LIFECYCLE_SELECT,
  type ClaimVersionRow,
  type SemanticMemoryRow,
} from "./hybridRows.js";
import {
  mapSnapshot,
  staleFileEvidence,
  type FileEvidenceRow,
  type FileSnapshotRow,
} from "./fileEvidence.js";
import { SUPERSEDED_CHAIN_SQL } from "./memoryRules.js";

/**
 * Marks a memory as re-verified now (dreaming's "still true"), optionally
 * with new evidence on its latest claim version. Null when it does not exist.
 */
export function confirmMemory(
  db: Database.Database,
  project: string,
  memoryId: number,
  evidence?: EvidenceInput
): SemanticMemory | null {
  return db.transaction(() => {
    const memory = getMemory(db, project, memoryId);
    if (!memory) return null;
    db.prepare(
      `UPDATE semantic_memories
       SET last_confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).run(memoryId);
    if (evidence) {
      const row = db
        .prepare(
          `SELECT * FROM claim_versions WHERE memory_id = ?
           ORDER BY recorded_at DESC, id DESC LIMIT 1`
        )
        .get(memoryId) as ClaimVersionRow;
      attachEvidence(db, memoryId, mapClaimVersion(row), evidence, memory.content);
    }
    return getMemory(db, project, memoryId);
  })();
}

/**
 * Retires a memory as wrong: it and its active claim version become
 * "invalidated" (kept for audit, never retrieved as current). The reason is
 * kept in the memory's metadata under `invalidation`.
 */
export function invalidateMemory(
  db: Database.Database,
  project: string,
  memoryId: number,
  reason?: string
): SemanticMemory | null {
  return db.transaction(() => {
    const memory = getMemory(db, project, memoryId);
    if (!memory) return null;
    const timestamp = new Date().toISOString();
    const metadata = {
      ...memory.metadata,
      invalidation: { at: timestamp, reason: reason?.trim() || null },
    };
    db.prepare(
      `UPDATE semantic_memories
       SET status = 'invalidated', metadata_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(JSON.stringify(metadata), timestamp, memoryId);
    db.prepare(
      `UPDATE claim_versions SET status = 'invalidated', retracted_at = COALESCE(retracted_at, ?)
       WHERE memory_id = ? AND status = 'active'`
    ).run(timestamp, memoryId);
    return getMemory(db, project, memoryId);
  })();
}

/**
 * Forgets a memory and the superseded versions it replaced (its
 * `supersedesId` chain): deletes them with their claim versions, evidence
 * links, tags, key and embeddings. Source episodes stay. False when the
 * memory did not exist.
 */
export function deleteSemanticMemory(
  db: Database.Database,
  project: string,
  memoryId: number
): boolean {
  return db.transaction(() => {
    const ids = db
      .prepare(SUPERSEDED_CHAIN_SQL.replaceAll("$1", "?").replaceAll("$2", "?"))
      .all(project, memoryId, project) as Array<{ id: number }>;
    const remove = db.prepare("DELETE FROM semantic_memories WHERE id = ?");
    for (const { id } of ids) remove.run(id);
    return ids.length > 0;
  })();
}

/**
 * Flags two memories of the project as contradicting each other (dreaming's
 * "these disagree"). Null when either is missing or they are the same.
 */
export function flagConflict(
  db: Database.Database,
  project: string,
  memoryId: number,
  conflictingId: number,
  reason: string
): MemoryConflict | null {
  return db.transaction(() => {
    if (memoryId === conflictingId) return null;
    if (!getMemory(db, project, memoryId) || !getMemory(db, project, conflictingId)) {
      return null;
    }
    return createConflict(db, project, memoryId, conflictingId, reason);
  })();
}

/**
 * Stores one version of a repository file as an episode (role "file", source
 * `repo://<path>`), once per content hash. Memories cite it as evidence like
 * any episode.
 */
export function recordFileSnapshot(
  db: Database.Database,
  project: string,
  input: { source: string; content: string; session?: string; tags?: string[] }
): { snapshot: FileSnapshot; episode: ReturnType<typeof getEpisode>; created: boolean } {
  const source = normalizeRepoSource(input.source);
  const hash = contentHash(input.content);
  const tags = normalizeTags(input.tags);
  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT * FROM file_snapshots WHERE project = ? AND source = ? AND content_hash = ?`
      )
      .get(project, source, hash) as FileSnapshotRow | undefined;
    if (existing) {
      return {
        snapshot: mapSnapshot(existing),
        episode: getEpisode(db, project, existing.episode_id),
        created: false,
      };
    }
    const episode = appendEpisode(db, project, {
      session: input.session,
      role: "file",
      content: input.content,
      source,
      metadata: { contentHash: hash },
      tags,
    });
    const row = db
      .prepare(
        `INSERT INTO file_snapshots (episode_id, project, source, content_hash)
         VALUES (?, ?, ?, ?) RETURNING *`
      )
      .get(episode.id, project, source, hash) as FileSnapshotRow;
    return { snapshot: mapSnapshot(row), episode, created: true };
  })();
}

/** Active memories whose evidence for a given file is from other versions only. */
export function findStaleFileEvidence(
  db: Database.Database,
  project: string,
  files: Array<{ source: string; contentHash: string }>
): StaleFileEvidence[] {
  const sources = [...new Set(files.map((file) => file.source))];
  const rows = db
    .prepare(
      `SELECT DISTINCT cv.memory_id, fs.source, fs.content_hash
       FROM file_snapshots fs
       JOIN memory_evidence me ON me.episode_id = fs.episode_id
       JOIN claim_versions cv ON cv.id = me.claim_version_id
       JOIN semantic_memories sm ON sm.id = cv.memory_id
       WHERE fs.project = ? AND sm.status = 'active'
         AND fs.source IN (${sources.map(() => "?").join(", ")})`
    )
    .all(project, ...sources) as FileEvidenceRow[];
  return staleFileEvidence(files, rows);
}

export function listSemanticMemories(
  db: Database.Database,
  project: string,
  opts: SemanticMemoryListOptions = {}
): SemanticMemory[] {
  const params: Array<string | number> = [project];
  const bind = (value: string | number) => {
    params.push(value);
    return "?";
  };
  const clauses = semanticListClauses(opts, bind, "sm.project = ?");
  params.push(opts.limit ?? 100, opts.offset ?? 0);
  return (
    db
      .prepare(
        `${MEMORY_WITH_LIFECYCLE_SELECT}
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${semanticListOrder(opts)}
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
