import { createLocalExtractor } from "../../memory/extractor.js";
import {
  episodeColumns,
  mapClaimVersion,
  mapConflict,
  mapEpisode,
  mapMemory,
  mapMemoryEvidence,
  mapResolutionEvent,
  PG_MEMORY_SELECT,
  type ClaimVersionRow,
  type ConflictResolutionEventRow,
  type EpisodeRow,
  type MemoryConflictRow,
  type MemoryEvidenceRow,
  type SemanticMemoryRow,
} from "../hybridRows.js";
import { getMemorySourcesPg } from "./channels.js";
import { pgBinder, withTransaction, type Pool, type Queryable } from "./client.js";
import { upsertLocalEmbeddingPg } from "./embeddingOps.js";
import {
  attachEvidencePg,
  findActiveEquivalentPg,
  findConflictingMemoryPg,
  getMemoryPg,
  insertClaimVersionPg,
  insertSemanticMemoryPg,
  latestClaimVersionIdPg,
  reinforceMemoryPg,
} from "./hybridWrite.js";
import {
  sameClaim,
  semanticListClauses,
  semanticListOrder,
  successorClaim,
  type SemanticMemoryListOptions,
} from "../memoryRules.js";
import {
  EPISODE_TAGS,
  normalizeTags,
  StateError,
  tagPredicate,
} from "../../memory/tags.js";
import type { MemoryExplanation } from "../temporalMemory.js";
import type { MemoryStore } from "../store.js";
import type {
  CandidateMemory,
  Episode,
  EvidenceInput,
  MemoryConflict,
  SemanticMemory,
  TagFilter,
} from "../../memory/types.js";

const EPISODE_COLUMNS =
  "id, project, session, actor, role, content, source, metadata_json, created_at";
const TAGGED_EPISODE_COLUMNS = episodeColumns("pg", "episodes");

export async function appendEpisodePg(
  pool: Pool,
  project: string,
  input: Parameters<MemoryStore["appendEpisode"]>[1]
): Promise<Episode> {
  const tags = normalizeTags(input.tags);
  const episode = await withTransaction(pool, (client) =>
    insertEpisodePg(client, project, input, tags)
  );
  await upsertLocalEmbeddingPg(pool, "episode", episode.id, project, episode.content);
  return episode;
}

export async function insertEpisodePg(
  db: Queryable,
  project: string,
  input: Parameters<MemoryStore["appendEpisode"]>[1],
  tags: string[]
): Promise<Episode> {
  const { rows } = await db.query<EpisodeRow>(
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
  for (const tag of tags) {
    await db.query(`INSERT INTO episode_tags (episode_id, tag) VALUES ($1, $2)`, [
      rows[0].id,
      tag,
    ]);
  }
  return { ...mapEpisode(rows[0]), tags };
}

export async function getEpisodePg(
  pool: Pool,
  project: string,
  id: number
): Promise<Episode | null> {
  const { rows } = await pool.query<EpisodeRow>(
    `SELECT ${TAGGED_EPISODE_COLUMNS} FROM episodes WHERE project = $1 AND id = $2`,
    [project, id]
  );
  return rows[0] ? mapEpisode(rows[0]) : null;
}

export async function listEpisodesPg(
  pool: Pool,
  project: string,
  opts: { session?: string; tags?: TagFilter; limit?: number; offset?: number } = {}
): Promise<Episode[]> {
  const params: unknown[] = [project];
  const bind = pgBinder(params);
  const clauses = ["project = $1"];
  if (opts.session) clauses.push(`session = ${bind(opts.session)}`);
  if (opts.tags) clauses.push(tagPredicate(EPISODE_TAGS, "episodes.id", opts.tags, bind));
  const { rows } = await pool.query<EpisodeRow>(
    `SELECT ${TAGGED_EPISODE_COLUMNS}
     FROM episodes
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT ${bind(opts.limit ?? 50)} OFFSET ${bind(opts.offset ?? 0)}`,
    params
  );
  return rows.map(mapEpisode);
}

/** Mirrors hybridMemory.upsertSemanticMemory (tags, keys, reinforcement). */
export async function upsertSemanticMemoryPg(
  pool: Pool,
  project: string,
  input: CandidateMemory,
  sourceEpisodeId?: number,
  evidence?: { quote?: string; spanStart?: number }
): Promise<SemanticMemory> {
  const tags = normalizeTags(input.tags);
  const source = sourceEpisodeId ? { sourceEpisodeId, ...evidence } : undefined;
  const memoryId = await withTransaction(pool, async (client) => {
    const keyed = input.key ? await getMemoryByKeyPg(client, project, input.key) : null;
    if (keyed?.status === "active") {
      return sameClaim(keyed, input)
        ? (await reinforceMemoryPg(client, keyed, input, source)).id
        : (await supersedeWithinPg(client, keyed, input, source)).id;
    }
    const existing = input.key
      ? null
      : await findActiveEquivalentPg(client, project, input, tags);
    if (existing) return (await reinforceMemoryPg(client, existing, input, source)).id;
    const conflicting = await findConflictingMemoryPg(client, project, input, tags);
    const inserted = await insertTaggedMemoryPg(client, project, input, tags, source);
    if (conflicting) {
      await createConflictPg(
        client,
        project,
        inserted.id,
        conflicting.memory.id,
        conflicting.reason
      );
    }
    return inserted.id;
  });
  return (await getMemoryPg(pool, project, memoryId)) as SemanticMemory;
}

/** Mirrors hybridMemory.supersedeMemory. */
export async function supersedeMemoryPg(
  pool: Pool,
  project: string,
  memoryId: number,
  input: Partial<CandidateMemory> & { content: string },
  evidence?: EvidenceInput
): Promise<SemanticMemory | null> {
  const id = await withTransaction(pool, async (client) => {
    const old = await getMemoryPg(client, project, memoryId);
    if (!old) return null;
    return (await supersedeWithinPg(client, old, input, evidence)).id;
  });
  return id === null ? null : getMemoryPg(pool, project, id);
}

async function supersedeWithinPg(
  db: Queryable,
  old: SemanticMemory,
  input: Partial<CandidateMemory> & { content: string },
  evidence?: EvidenceInput
): Promise<SemanticMemory> {
  if (old.status !== "active") throw new StateError(`memory ${old.id} is ${old.status}`);
  await db.query(
    `UPDATE semantic_memories SET status = 'superseded', updated_at = now() WHERE id = $1`,
    [old.id]
  );
  await db.query(
    `UPDATE claim_versions SET status = 'superseded', retracted_at = COALESCE(retracted_at, now())
     WHERE memory_id = $1 AND status = 'active'`,
    [old.id]
  );
  if (old.key) await db.query(`DELETE FROM memory_keys WHERE memory_id = $1`, [old.id]);
  const next = await insertTaggedMemoryPg(
    db,
    old.project,
    successorClaim(old, input),
    input.tags ? normalizeTags(input.tags) : old.tags,
    evidence,
    {
      supersedesId: old.id,
      supersedesVersionId: await latestClaimVersionIdPg(db, old.id),
    }
  );
  if (old.key) await assignKeyPg(db, old.project, old.key, next.id);
  return next;
}

async function insertTaggedMemoryPg(
  db: Queryable,
  project: string,
  input: CandidateMemory,
  tags: string[],
  evidence?: EvidenceInput,
  chain: { supersedesId?: number; supersedesVersionId?: number } = {}
): Promise<SemanticMemory> {
  const inserted = await insertSemanticMemoryPg(db, project, input, chain.supersedesId);
  for (const tag of tags) {
    await db.query(`INSERT INTO memory_tags (memory_id, tag) VALUES ($1, $2)`, [
      inserted.id,
      tag,
    ]);
  }
  if (input.key) await assignKeyPg(db, project, input.key, inserted.id);
  const version = await insertClaimVersionPg(
    db,
    inserted,
    input,
    chain.supersedesVersionId
  );
  if (evidence) await attachEvidencePg(db, inserted.id, version, evidence, input.content);
  await upsertLocalEmbeddingPg(db, "memory", inserted.id, project, inserted.content);
  return inserted;
}

export async function getMemoryByKeyPg(
  db: Queryable,
  project: string,
  key: string
): Promise<SemanticMemory | null> {
  const { rows } = await db.query<SemanticMemoryRow>(
    `${PG_MEMORY_SELECT}
     JOIN memory_keys mk ON mk.memory_id = sm.id
     WHERE mk.project = $1 AND mk.memory_key = $2`,
    [project, key]
  );
  return rows[0] ? mapMemory(rows[0]) : null;
}

async function assignKeyPg(
  db: Queryable,
  project: string,
  key: string,
  memoryId: number
): Promise<void> {
  await db.query(
    `INSERT INTO memory_keys (project, memory_key, memory_id) VALUES ($1, $2, $3)
     ON CONFLICT (project, memory_key) DO UPDATE SET memory_id = EXCLUDED.memory_id`,
    [project, key, memoryId]
  );
}

/** Mirrors hybridMemory.createConflict. */
export async function createConflictPg(
  db: Queryable,
  project: string,
  memoryId: number,
  conflictingId: number,
  reason: string
): Promise<MemoryConflict> {
  const open = await db.query<MemoryConflictRow>(
    `SELECT * FROM memory_conflicts
     WHERE project = $1 AND resolution_status = 'open'
       AND ((memory_id = $2 AND conflicting_id = $3) OR (memory_id = $3 AND conflicting_id = $2))`,
    [project, memoryId, conflictingId]
  );
  if (open.rows[0]) return mapConflict(open.rows[0]);
  const { rows } = await db.query<MemoryConflictRow>(
    `INSERT INTO memory_conflicts (project, memory_id, conflicting_id, reason)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [project, memoryId, conflictingId, reason]
  );
  return mapConflict(rows[0]);
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
  opts: SemanticMemoryListOptions = {}
): Promise<SemanticMemory[]> {
  const params: unknown[] = [project];
  const bind = pgBinder(params);
  const clauses = semanticListClauses(opts, bind, "sm.project = $1");
  const { rows } = await pool.query<SemanticMemoryRow>(
    `${PG_MEMORY_SELECT}
     WHERE ${clauses.join(" AND ")}
     ORDER BY ${semanticListOrder(opts)}
     LIMIT ${bind(opts.limit ?? 100)} OFFSET ${bind(opts.offset ?? 0)}`,
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
