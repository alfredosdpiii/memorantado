import { semanticConflictReason } from "../../memory/conflicts.js";
import { contentHash } from "../../memory/localEmbedding.js";
import {
  mapClaimVersion,
  mapMemory,
  PG_MEMORY_SELECT,
  normalizeScope,
  type ClaimVersionRow,
  type EpisodeRow,
  type SemanticMemoryRow,
} from "../hybridRows.js";
import type {
  CandidateMemory,
  ClaimVersion,
  EvidenceInput,
  SemanticMemory,
} from "../../memory/types.js";
import { MEMORY_TAGS, tagPredicate } from "../../memory/tags.js";
import { pgBinder, type Queryable } from "./client.js";
import { upsertLocalEmbeddingPg } from "./embeddingOps.js";

export async function getMemoryPg(
  db: Queryable,
  project: string,
  id: number
): Promise<SemanticMemory | null> {
  const { rows } = await db.query<SemanticMemoryRow>(
    `${PG_MEMORY_SELECT} WHERE sm.project = $1 AND sm.id = $2`,
    [project, id]
  );
  return rows[0] ? mapMemory(rows[0]) : null;
}

export async function findActiveEquivalentPg(
  db: Queryable,
  project: string,
  input: CandidateMemory,
  tags: string[]
): Promise<SemanticMemory | null> {
  const params: unknown[] = [
    project,
    input.subject,
    input.predicate ?? "states",
    input.content,
  ];
  const sameTags = tagPredicate(
    MEMORY_TAGS,
    "sm.id",
    { tags, match: "exact" },
    pgBinder(params)
  );
  const { rows } = await db.query<SemanticMemoryRow>(
    `${PG_MEMORY_SELECT}
     WHERE sm.project = $1 AND sm.status = 'active'
       AND COALESCE(ml.status, 'active') = 'active'
       AND sm.subject = $2 AND sm.predicate = $3 AND sm.content = $4
       AND ${sameTags}
     ORDER BY sm.updated_at DESC
     LIMIT 1`,
    params
  );
  return rows[0] ? mapMemory(rows[0]) : null;
}

export async function findConflictingMemoryPg(
  db: Queryable,
  project: string,
  input: CandidateMemory,
  tags: string[]
): Promise<{ memory: SemanticMemory; reason: string } | null> {
  const params: unknown[] = [project, input.subject, input.predicate ?? "states"];
  const sameTags = tagPredicate(
    MEMORY_TAGS,
    "sm.id",
    { tags, match: "exact" },
    pgBinder(params)
  );
  const { rows } = await db.query<SemanticMemoryRow>(
    `${PG_MEMORY_SELECT}
     WHERE sm.project = $1 AND sm.status = 'active'
       AND COALESCE(ml.status, 'active') = 'active'
       AND sm.subject = $2 AND sm.predicate = $3
       AND ${sameTags}
     ORDER BY sm.updated_at DESC`,
    params
  );
  for (const row of rows) {
    const memory = mapMemory(row);
    const reason = semanticConflictReason(memory, input);
    if (reason) return { memory, reason };
  }
  return null;
}

export async function reinforceMemoryPg(
  db: Queryable,
  existing: SemanticMemory,
  input: CandidateMemory,
  evidence?: EvidenceInput
): Promise<SemanticMemory> {
  const { rows } = await db.query<SemanticMemoryRow>(
    `UPDATE semantic_memories
     SET confidence = LEAST(1.0, confidence + 0.05),
         importance = GREATEST(importance, $1),
         last_confirmed_at = now(),
         updated_at = now()
     WHERE id = $2
     RETURNING *`,
    [input.importance ?? existing.importance, existing.id]
  );
  const memory = mapMemory(rows[0]);
  const version = await insertClaimVersionPg(
    db,
    memory,
    input,
    await latestClaimVersionIdPg(db, memory.id)
  );
  if (evidence) await attachEvidencePg(db, existing.id, version, evidence, input.content);
  return memory;
}

/** Links quoted evidence from an episode to a memory's claim version. */
export async function attachEvidencePg(
  db: Queryable,
  memoryId: number,
  version: ClaimVersion,
  evidence: EvidenceInput,
  fallbackQuote: string
): Promise<void> {
  const quote = evidence.quote ?? fallbackQuote;
  await linkMemorySourcePg(db, memoryId, evidence.sourceEpisodeId, quote);
  await insertMemoryEvidencePg(
    db,
    version,
    evidence.sourceEpisodeId,
    quote,
    evidence.spanStart
  );
}

export async function insertSemanticMemoryPg(
  db: Queryable,
  project: string,
  input: CandidateMemory,
  supersedesId?: number
): Promise<SemanticMemory> {
  const { rows } = await db.query<SemanticMemoryRow>(
    `INSERT INTO semantic_memories (
       project, scope, kind, subject, predicate, object, content, confidence,
       importance, valid_from, valid_to, last_confirmed_at, metadata_json, supersedes_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12, $13)
     RETURNING *`,
    [
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
      input.metadata ? JSON.stringify(input.metadata) : null,
      supersedesId ?? null,
    ]
  );
  return mapMemory(rows[0]);
}

export async function insertClaimVersionPg(
  db: Queryable,
  memory: SemanticMemory,
  input: CandidateMemory,
  supersedesVersionId?: number
): Promise<ClaimVersion> {
  const metadata = input.metadata ?? memory.metadata;
  const extractorId =
    typeof metadata?.extractor === "string" ? metadata.extractor : "manual";
  const { rows } = await db.query<ClaimVersionRow>(
    `INSERT INTO claim_versions (
       memory_id, project, scope, kind, subject, predicate, object, content,
       confidence, importance, status, valid_from, valid_to,
       supersedes_version_id, metadata_json, extractor_id, extractor_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      memory.id,
      memory.project,
      memory.scope,
      memory.kind,
      memory.subject,
      memory.predicate,
      memory.object,
      memory.content,
      memory.confidence,
      memory.importance,
      memory.status,
      input.validFrom ?? memory.validFrom,
      input.validTo ?? memory.validTo,
      supersedesVersionId ?? null,
      metadata ? JSON.stringify(metadata) : null,
      extractorId,
      "1",
    ]
  );
  const row = rows[0];
  if (supersedesVersionId) {
    await db.query(
      `UPDATE claim_versions
       SET status = 'superseded', retracted_at = $1
       WHERE id = $2 AND retracted_at IS NULL`,
      [row.recorded_at, supersedesVersionId]
    );
  }
  // Embed once at write time (deterministic local hash), mirroring sqlite.
  await upsertLocalEmbeddingPg(db, "claim_version", row.id, memory.project, row.content);
  return mapClaimVersion(row);
}

export async function latestClaimVersionIdPg(
  db: Queryable,
  memoryId: number
): Promise<number | undefined> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM claim_versions
     WHERE memory_id = $1
     ORDER BY recorded_at DESC, id DESC
     LIMIT 1`,
    [memoryId]
  );
  return rows[0]?.id;
}

async function insertMemoryEvidencePg(
  db: Queryable,
  version: ClaimVersion,
  episodeId: number,
  quote: string,
  spanStart?: number
): Promise<void> {
  const { rows } = await db.query<EpisodeRow>(
    `SELECT id, project, session, actor, role, content, source, metadata_json, created_at
     FROM episodes WHERE id = $1`,
    [episodeId]
  );
  const episode = rows[0];
  if (!episode) return;
  const start = spanStart ?? episode.content.indexOf(quote);
  await db.query(
    `INSERT INTO memory_evidence (
       claim_version_id, episode_id, quote, span_start, span_end, content_hash,
       polarity, actor, source, observed_at, ingested_at, extractor_id,
       extractor_version
     ) VALUES ($1, $2, $3, $4, $5, $6, 'supports', $7, $8, $9, $10, $11, $12)
     ON CONFLICT DO NOTHING`,
    [
      version.id,
      episode.id,
      quote,
      start >= 0 ? start : null,
      start >= 0 ? start + quote.length : null,
      contentHash(quote),
      episode.actor,
      episode.source,
      observedAt(episode),
      episode.created_at,
      version.extractorId,
      version.extractorVersion,
    ]
  );
}

async function linkMemorySourcePg(
  db: Queryable,
  memoryId: number,
  episodeId: number,
  quote: string
): Promise<void> {
  await db.query(
    `INSERT INTO memory_sources (memory_id, episode_id, quote)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [memoryId, episodeId, quote]
  );
}

function observedAt(episode: EpisodeRow): string {
  if (episode.metadata_json) {
    const metadata = JSON.parse(episode.metadata_json) as Record<string, unknown>;
    for (const key of ["observedAt", "date", "createdAt"]) {
      const value = metadata[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return episode.created_at;
}
