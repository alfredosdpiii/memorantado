import { createLocalExtractor } from "../../memory/extractor.js";
import {
  mapClaimVersion,
  mapConflict,
  mapEpisode,
  mapMemory,
  mapMemoryEvidence,
  mapResolutionEvent,
  MEMORY_WITH_LIFECYCLE_SELECT,
  type ClaimVersionRow,
  type ConflictResolutionEventRow,
  type EpisodeRow,
  type MemoryConflictRow,
  type MemoryEvidenceRow,
  type SemanticMemoryRow,
} from "../hybridRows.js";
import { getMemorySourcesPg } from "./channels.js";
import { withTransaction, type Pool } from "./client.js";
import { upsertLocalEmbeddingPg } from "./embeddingOps.js";
import {
  findActiveEquivalentPg,
  findConflictingMemoryPg,
  getMemoryPg,
  insertClaimVersionPg,
  insertMemoryEvidencePg,
  insertSemanticMemoryPg,
  linkMemorySourcePg,
  reinforceMemoryPg,
} from "./hybridWrite.js";
import type { MemoryExplanation } from "../temporalMemory.js";
import type { MemoryStore } from "../store.js";
import type {
  CandidateMemory,
  Episode,
  MemoryConflict,
  SemanticMemory,
} from "../../memory/types.js";

const EPISODE_COLUMNS =
  "id, project, session, actor, role, content, source, metadata_json, created_at";

export async function appendEpisodePg(
  pool: Pool,
  project: string,
  input: Parameters<MemoryStore["appendEpisode"]>[1]
): Promise<Episode> {
  const { rows } = await pool.query<EpisodeRow>(
    `INSERT INTO episodes (project, session, actor, role, content, source, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${EPISODE_COLUMNS}`,
    [
      project,
      input.session ?? null,
      input.actor ?? null,
      input.role ?? "user",
      input.content,
      input.source ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]
  );
  const episode = mapEpisode(rows[0]);
  await upsertLocalEmbeddingPg(pool, "episode", episode.id, project, episode.content);
  return episode;
}

export async function getEpisodePg(
  pool: Pool,
  project: string,
  id: number
): Promise<Episode | null> {
  const { rows } = await pool.query<EpisodeRow>(
    `SELECT ${EPISODE_COLUMNS} FROM episodes WHERE project = $1 AND id = $2`,
    [project, id]
  );
  return rows[0] ? mapEpisode(rows[0]) : null;
}

export async function listEpisodesPg(
  pool: Pool,
  project: string,
  opts: { session?: string; limit?: number; offset?: number } = {}
): Promise<Episode[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const params: Array<string | number> = [project];
  let sessionClause = "";
  if (opts.session) {
    params.push(opts.session);
    sessionClause = `AND session = $${params.length}`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query<EpisodeRow>(
    `SELECT ${EPISODE_COLUMNS}
     FROM episodes
     WHERE project = $1 ${sessionClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(mapEpisode);
}

export async function upsertSemanticMemoryPg(
  pool: Pool,
  project: string,
  input: CandidateMemory,
  sourceEpisodeId?: number,
  evidence?: { quote?: string; spanStart?: number }
): Promise<SemanticMemory> {
  const memory = await withTransaction(pool, async (client) => {
    const existing = await findActiveEquivalentPg(client, project, input);
    if (existing) {
      return reinforceMemoryPg(client, existing, input, sourceEpisodeId, evidence);
    }
    const conflicting = await findConflictingMemoryPg(client, project, input);
    const inserted = await insertSemanticMemoryPg(client, project, input);
    const version = await insertClaimVersionPg(client, inserted, input);
    if (sourceEpisodeId) {
      const quote = evidence?.quote ?? input.content;
      await linkMemorySourcePg(client, inserted.id, sourceEpisodeId, quote);
      await insertMemoryEvidencePg(
        client,
        version,
        sourceEpisodeId,
        quote,
        evidence?.spanStart
      );
    }
    if (conflicting) {
      await client.query(
        `INSERT INTO memory_conflicts (project, memory_id, conflicting_id, reason)
         VALUES ($1, $2, $3, $4)`,
        [project, inserted.id, conflicting.memory.id, conflicting.reason]
      );
    }
    return inserted;
  });
  await upsertLocalEmbeddingPg(pool, "memory", memory.id, project, memory.content);
  return memory;
}

export async function extractMemoriesPg(
  pool: Pool,
  project: string,
  episodeId: number
): Promise<SemanticMemory[]> {
  const episode = await getEpisodePg(pool, project, episodeId);
  if (!episode) return [];
  const candidates = await createLocalExtractor().extract(episode);
  const memories: SemanticMemory[] = [];
  for (const candidate of candidates) {
    memories.push(
      await upsertSemanticMemoryPg(pool, project, candidate, episode.id, {
        quote: candidate.content,
        spanStart: episode.content.indexOf(candidate.content),
      })
    );
  }
  return memories;
}

export async function listSemanticMemoriesPg(
  pool: Pool,
  project: string,
  opts: {
    status?: string;
    lifecycleStatus?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<SemanticMemory[]> {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const clauses = ["sm.project = $1"];
  const params: Array<string | number> = [project];
  if (opts.status) {
    clauses.push(`sm.status = $${params.length + 1}`);
    params.push(opts.status);
  }
  if (opts.lifecycleStatus) {
    clauses.push(`COALESCE(ml.status, 'active') = $${params.length + 1}`);
    params.push(opts.lifecycleStatus);
  }
  params.push(limit, offset);
  const { rows } = await pool.query<SemanticMemoryRow>(
    `${MEMORY_WITH_LIFECYCLE_SELECT}
     WHERE ${clauses.join(" AND ")}
     ORDER BY sm.importance DESC, sm.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(mapMemory);
}

export async function setMemoryLifecyclePg(
  pool: Pool,
  project: string,
  memoryId: number,
  status: "active" | "archived",
  reason?: string
): Promise<SemanticMemory | null> {
  const exists = await pool.query(
    `SELECT 1 FROM semantic_memories WHERE project = $1 AND id = $2`,
    [project, memoryId]
  );
  if (!exists.rows.length) return null;
  const timestamp = new Date().toISOString();
  await pool.query(
    `INSERT INTO memory_lifecycle (memory_id, status, reason, archived_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(memory_id) DO UPDATE SET
       status = EXCLUDED.status,
       reason = EXCLUDED.reason,
       archived_at = EXCLUDED.archived_at,
       updated_at = EXCLUDED.updated_at`,
    [
      memoryId,
      status,
      status === "archived" ? reason?.trim() || null : null,
      status === "archived" ? timestamp : null,
      timestamp,
    ]
  );
  return getMemoryPg(pool, project, memoryId);
}

export async function explainMemoryPg(
  pool: Pool,
  project: string,
  memoryId: number
): Promise<MemoryExplanation> {
  const memory = await getMemoryPg(pool, project, memoryId);
  const sources = memory ? await getMemorySourcesPg(pool, memory.id) : [];
  if (!memory) {
    return {
      memory: null,
      versions: [],
      evidence: [],
      sources: [],
      conflicts: [],
      resolutionEvents: [],
    };
  }
  const conflicts = (
    await pool.query<MemoryConflictRow>(
      `SELECT * FROM memory_conflicts
       WHERE project = $1 AND (memory_id = $2 OR conflicting_id = $2)
       ORDER BY created_at DESC`,
      [project, memory.id]
    )
  ).rows.map(mapConflict);
  const conflictIds = conflicts.map((conflict) => conflict.id);
  const resolutionEvents = conflictIds.length
    ? (
        await pool.query<ConflictResolutionEventRow>(
          `SELECT * FROM conflict_resolution_events
           WHERE project = $1 AND conflict_id = ANY($2)
           ORDER BY created_at DESC, id DESC`,
          [project, conflictIds]
        )
      ).rows.map(mapResolutionEvent)
    : [];
  const versions = (
    await pool.query<ClaimVersionRow>(
      `SELECT * FROM claim_versions
       WHERE project = $1 AND memory_id = $2
       ORDER BY recorded_at DESC, id DESC`,
      [project, memory.id]
    )
  ).rows.map(mapClaimVersion);
  const evidence = (
    await pool.query<MemoryEvidenceRow>(
      `SELECT me.*
       FROM memory_evidence me
       JOIN claim_versions cv ON cv.id = me.claim_version_id
       WHERE cv.project = $1 AND cv.memory_id = $2
       ORDER BY me.created_at DESC, me.id DESC`,
      [project, memory.id]
    )
  ).rows.map(mapMemoryEvidence);
  return { memory, versions, evidence, sources, conflicts, resolutionEvents };
}

export async function listConflictsPg(
  pool: Pool,
  project: string,
  status = "open"
): Promise<MemoryConflict[]> {
  const { rows } = await pool.query<MemoryConflictRow>(
    `SELECT * FROM memory_conflicts
     WHERE project = $1 AND resolution_status = $2
     ORDER BY created_at DESC`,
    [project, status]
  );
  return rows.map(mapConflict);
}

export async function resolveConflictPg(
  pool: Pool,
  project: string,
  conflictId: number,
  resolvedMemoryId?: number,
  status: "resolved" | "ignored" = "resolved",
  audit: { actor?: string; reason?: string; metadata?: Record<string, unknown> } = {}
): Promise<MemoryConflict | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<MemoryConflictRow>(
      `SELECT * FROM memory_conflicts WHERE project = $1 AND id = $2`,
      [project, conflictId]
    );
    const conflict = rows[0];
    if (!conflict) return null;
    if (status === "resolved") {
      const winnerId = resolvedMemoryId ?? conflict.memory_id;
      if (winnerId !== conflict.memory_id && winnerId !== conflict.conflicting_id) {
        throw new Error("resolved memory must belong to the conflict");
      }
      const loserId =
        winnerId === conflict.memory_id ? conflict.conflicting_id : conflict.memory_id;
      await client.query(
        `UPDATE semantic_memories
         SET status = 'active', supersedes_id = $1, updated_at = now()
         WHERE project = $2 AND id = $3`,
        [loserId, project, winnerId]
      );
      await client.query(
        `UPDATE semantic_memories
         SET status = 'superseded', updated_at = now()
         WHERE project = $1 AND id = $2`,
        [project, loserId]
      );
      await client.query(
        `UPDATE claim_versions
         SET status = 'superseded', retracted_at = COALESCE(retracted_at, now())
         WHERE project = $1 AND memory_id = $2 AND status = 'active'`,
        [project, loserId]
      );
      await client.query(
        `UPDATE claim_versions
         SET status = 'active', retracted_at = NULL
         WHERE id = (
           SELECT id FROM claim_versions WHERE project = $1 AND memory_id = $2
           ORDER BY recorded_at DESC, id DESC LIMIT 1
         )`,
        [project, winnerId]
      );
    }
    const updated = await client.query<MemoryConflictRow>(
      `UPDATE memory_conflicts
       SET resolution_status = $1, resolved_memory_id = $2, resolved_at = now()
       WHERE project = $3 AND id = $4
       RETURNING *`,
      [status, resolvedMemoryId ?? null, project, conflictId]
    );
    await client.query(
      `INSERT INTO conflict_resolution_events (
         conflict_id, project, action, resolved_memory_id, actor, reason, metadata_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        conflictId,
        project,
        status,
        resolvedMemoryId ?? null,
        audit.actor ?? null,
        audit.reason ?? null,
        audit.metadata ? JSON.stringify(audit.metadata) : null,
      ]
    );
    return mapConflict(updated.rows[0]);
  });
}
