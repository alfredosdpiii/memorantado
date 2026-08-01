import {
  cosineSimilarity,
  embedText as embedLocalText,
} from "../../memory/localEmbedding.js";
import {
  mapClaimVersion,
  mapConflict,
  mapEpisode,
  mapMemory,
  MEMORY_WITH_LIFECYCLE_SELECT,
  significantWords,
  type ClaimVersionRow,
  type EpisodeRow,
  type MemoryConflictRow,
  type SemanticMemoryRow,
} from "../hybridRows.js";
import type {
  ClaimVersion,
  ContextPack,
  Episode,
  MemoryConflict,
  RetrievalHit,
} from "../../memory/types.js";
import { toVectorLiteral, type Queryable } from "./client.js";
import type { RetrievalMode } from "../../memory/types.js";

const MIN_VECTOR_RELEVANCE = 0.35;

export type PgTemporalFilter = {
  mode: RetrievalMode;
  asOf: string | null;
  recordedAt: string | null;
};

/**
 * Mirrors hybridRows.ftsQuery tokenization: the same significant words
 * (lowercase alphanumeric, length > 2), OR-ed as prefix terms. Documented
 * difference vs FTS5: the 'english' text-search configuration drops stopwords
 * (FTS5's porter tokenizer indexes them) and stems with the Snowball english
 * stemmer instead of the original Porter stemmer.
 */
export function toPrefixTsquery(words: string[]): string {
  return words.map((word) => `'${word}':*`).join(" | ");
}

// ---------------------------------------------------------------------------
// bm25 channel (tsvector + ts_rank_cd; FTS5 counterpart documented in
// retrieval.ts)
// ---------------------------------------------------------------------------

export async function searchMemoryFts(
  db: Queryable,
  project: string,
  tsquery: string,
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  const { rows } = await db.query<{ id: number; score: number }>(
    `SELECT sm.id, ts_rank_cd(sm.search_vector, q.query) AS score
     FROM (SELECT to_tsquery('english', $2) AS query) q,
          semantic_memories sm
     LEFT JOIN memory_lifecycle ml ON ml.memory_id = sm.id
     WHERE sm.project = $1 AND sm.status = 'active'
       AND COALESCE(ml.status, 'active') = 'active'
       AND sm.search_vector @@ q.query
     ORDER BY score DESC, sm.id ASC
     LIMIT $3`,
    [project, tsquery, limit]
  );
  return rows;
}

export async function searchEpisodeFts(
  db: Queryable,
  project: string,
  tsquery: string,
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  const { rows } = await db.query<{ id: number; score: number }>(
    `SELECT e.id, ts_rank_cd(e.search_vector, q.query) AS score
     FROM (SELECT to_tsquery('english', $2) AS query) q,
          episodes e
     WHERE e.project = $1 AND e.search_vector @@ q.query
     ORDER BY score DESC, e.id ASC
     LIMIT $3`,
    [project, tsquery, limit]
  );
  return rows;
}

export async function searchVersionFts(
  db: Queryable,
  project: string,
  tsquery: string,
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  const { rows } = await db.query<{ id: number; score: number }>(
    `SELECT cv.id, ts_rank_cd(cv.search_vector, q.query) AS score
     FROM (SELECT to_tsquery('english', $2) AS query) q,
          claim_versions cv
     WHERE cv.project = $1 AND cv.search_vector @@ q.query
     ORDER BY score DESC, cv.id ASC
     LIMIT $3`,
    [project, tsquery, limit]
  );
  return rows;
}

export function ftsWords(query: string): string[] {
  return significantWords(query);
}

// ---------------------------------------------------------------------------
// vector channel (pgvector KNN for local-hash; exact scan for other providers)
// ---------------------------------------------------------------------------

export async function knnMemoryIds(
  db: Queryable,
  project: string,
  vector: number[],
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  const { rows } = await db.query<{ id: number; distance: number }>(
    `SELECT me.memory_id AS id, me.embedding <=> $1::vector AS distance
     FROM memory_embeddings me
     JOIN semantic_memories sm ON sm.id = me.memory_id
     LEFT JOIN memory_lifecycle ml ON ml.memory_id = sm.id
     WHERE me.project = $2 AND me.provider = 'local-hash'
       AND sm.status = 'active' AND COALESCE(ml.status, 'active') = 'active'
     ORDER BY distance ASC, me.memory_id ASC
     LIMIT $3`,
    [toVectorLiteral(vector), project, limit]
  );
  // pgvector cosine distance d -> relevance = 1 - d, same threshold semantics
  // as sqlite's cosineSimilarity >= MIN_VECTOR_RELEVANCE filter.
  return rows
    .map((row) => ({ id: row.id, score: 1 - row.distance }))
    .filter((entry) => entry.score >= MIN_VECTOR_RELEVANCE);
}

export async function knnEpisodeIds(
  db: Queryable,
  project: string,
  vector: number[],
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  const { rows } = await db.query<{ id: number; distance: number }>(
    `SELECT ee.episode_id AS id, ee.embedding <=> $1::vector AS distance
     FROM episode_embeddings ee
     WHERE ee.project = $2 AND ee.provider = 'local-hash'
     ORDER BY distance ASC, ee.episode_id ASC
     LIMIT $3`,
    [toVectorLiteral(vector), project, limit]
  );
  return rows
    .map((row) => ({ id: row.id, score: 1 - row.distance }))
    .filter((entry) => entry.score >= MIN_VECTOR_RELEVANCE);
}

export async function knnClaimVersionIds(
  db: Queryable,
  project: string,
  query: string,
  temporal: PgTemporalFilter,
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  const queryVector = embedLocalText(query);
  const temporalSql = temporalClauses(temporal, 3);
  const { rows } = await db.query<{ id: number; distance: number }>(
    `SELECT cve.claim_version_id AS id, cve.embedding <=> $1::vector AS distance
     FROM claim_version_embeddings cve
     JOIN claim_versions cv ON cv.id = cve.claim_version_id
     WHERE cve.project = $2 AND cve.provider = 'local-hash'
       ${temporalSql.clauses.length ? `AND ${temporalSql.clauses.join(" AND ")}` : ""}
     ORDER BY distance ASC, cve.claim_version_id ASC
     LIMIT $${temporalSql.params.length + 3}`,
    [toVectorLiteral(queryVector), project, ...temporalSql.params, limit]
  );
  return rows
    .map((row) => ({ id: row.id, score: 1 - row.distance }))
    .filter((entry) => entry.score >= MIN_VECTOR_RELEVANCE);
}

// Non-local-hash providers (e.g. Ollama) stay unindexed exact KNN on pg, the
// same semantics sqlite has always had: every stored vector for the provider
// is scored in JS and all rows above the threshold are returned.
export async function exactMemoryVectorScan(
  db: Queryable,
  project: string,
  queryEmbedding: { provider: string; vector: number[] }
): Promise<Array<{ id: number; score: number }>> {
  const { rows } = await db.query<{ id: number; vector_json: string }>(
    `SELECT me.memory_id AS id, me.vector_json
     FROM memory_embeddings me
     JOIN semantic_memories sm ON sm.id = me.memory_id
     LEFT JOIN memory_lifecycle ml ON ml.memory_id = sm.id
     WHERE me.project = $1 AND me.provider = $2
       AND sm.status = 'active' AND COALESCE(ml.status, 'active') = 'active'
     ORDER BY me.memory_id ASC`,
    [project, queryEmbedding.provider]
  );
  return rankExactScan(queryEmbedding.vector, rows);
}

export async function exactEpisodeVectorScan(
  db: Queryable,
  project: string,
  queryEmbedding: { provider: string; vector: number[] }
): Promise<Array<{ id: number; score: number }>> {
  const { rows } = await db.query<{ id: number; vector_json: string }>(
    `SELECT ee.episode_id AS id, ee.vector_json
     FROM episode_embeddings ee
     WHERE ee.project = $1 AND ee.provider = $2
     ORDER BY ee.episode_id ASC`,
    [project, queryEmbedding.provider]
  );
  return rankExactScan(queryEmbedding.vector, rows);
}

function rankExactScan(
  queryVector: number[],
  rows: Array<{ id: number; vector_json: string }>
): Array<{ id: number; score: number }> {
  return rows
    .map((row) => ({
      id: row.id,
      score: cosineSimilarity(queryVector, JSON.parse(row.vector_json)),
    }))
    .filter((entry) => entry.score >= MIN_VECTOR_RELEVANCE)
    .sort((left, right) => right.score - left.score || left.id - right.id);
}

// ---------------------------------------------------------------------------
// candidate materialization + temporal filtering
// ---------------------------------------------------------------------------

export async function fetchMemoriesByIds(
  db: Queryable,
  ids: number[]
): Promise<ReturnType<typeof mapMemory>[]> {
  const { rows } = await db.query<SemanticMemoryRow>(
    `${MEMORY_WITH_LIFECYCLE_SELECT} WHERE sm.id = ANY($1)`,
    [ids]
  );
  return rows.map(mapMemory);
}

export async function fetchEpisodesByIds(
  db: Queryable,
  ids: number[]
): Promise<Episode[]> {
  const { rows } = await db.query<EpisodeRow>(
    `SELECT id, project, session, actor, role, content, source, metadata_json, created_at
     FROM episodes WHERE id = ANY($1)`,
    [ids]
  );
  return rows.map(mapEpisode);
}

export async function listClaimVersionsForRetrieval(
  db: Queryable,
  project: string,
  temporal: PgTemporalFilter,
  limit: number
): Promise<ClaimVersion[]> {
  const temporalSql = temporalClauses(temporal, 2);
  const { rows } = await db.query<ClaimVersionRow>(
    `SELECT cv.* FROM claim_versions cv
     WHERE cv.project = $1
       ${temporalSql.clauses.length ? `AND ${temporalSql.clauses.join(" AND ")}` : ""}
     ORDER BY cv.recorded_at DESC, cv.id DESC
     LIMIT $${temporalSql.params.length + 2}`,
    [project, ...temporalSql.params, limit]
  );
  return rows.map(mapClaimVersion);
}

function temporalClauses(
  temporal: PgTemporalFilter,
  startIndex: number
): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  let index = startIndex;
  if (temporal.recordedAt) {
    clauses.push(
      `cv.recorded_at <= $${index}`,
      `(cv.retracted_at IS NULL OR cv.retracted_at > $${index + 1})`
    );
    params.push(temporal.recordedAt, temporal.recordedAt);
    index += 2;
  }
  if (temporal.mode === "as_of") {
    if (!temporal.asOf) throw new Error("asOf is required when mode is as_of");
    clauses.push(`(cv.valid_from IS NULL OR cv.valid_from <= $${index})`);
    clauses.push(`(cv.valid_to IS NULL OR cv.valid_to > $${index + 1})`);
    params.push(temporal.asOf, temporal.asOf);
  } else if (temporal.mode === "history") {
    clauses.push("(cv.valid_from IS NOT NULL OR cv.valid_to IS NOT NULL)");
  }
  return { clauses, params };
}

// ---------------------------------------------------------------------------
// sources, conflicts, access log
// ---------------------------------------------------------------------------

export async function getMemorySourcesPg(
  db: Queryable,
  memoryId: number
): Promise<Episode[]> {
  const { rows } = await db.query<EpisodeRow>(
    `SELECT e.id, e.project, e.session, e.actor, e.role, e.content, e.source,
            e.metadata_json, e.created_at
     FROM memory_sources ms
     JOIN episodes e ON e.id = ms.episode_id
     WHERE ms.memory_id = $1
     ORDER BY e.created_at DESC
     LIMIT 5`,
    [memoryId]
  );
  return rows.map(mapEpisode);
}

export async function getVersionSourcesPg(
  db: Queryable,
  versionId: number
): Promise<Episode[]> {
  const { rows } = await db.query<EpisodeRow>(
    `SELECT DISTINCT e.id, e.project, e.session, e.actor, e.role, e.content,
            e.source, e.metadata_json, e.created_at
     FROM memory_evidence me
     JOIN episodes e ON e.id = me.episode_id
     WHERE me.claim_version_id = $1
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT 5`,
    [versionId]
  );
  return rows.map(mapEpisode);
}

export async function listOpenConflictsForHits(
  db: Queryable,
  project: string,
  hits: RetrievalHit[]
): Promise<MemoryConflict[]> {
  const ids = hits.map((hit) => hit.id);
  if (!ids.length) return [];
  const { rows } = await db.query<MemoryConflictRow>(
    `SELECT * FROM memory_conflicts
     WHERE project = $1 AND resolution_status = 'open'
       AND (memory_id = ANY($2) OR conflicting_id = ANY($2))
     ORDER BY created_at DESC`,
    [project, ids]
  );
  return rows.map(mapConflict);
}

export async function logAccessPg(
  db: Queryable,
  project: string,
  pack: ContextPack
): Promise<void> {
  await db.query(
    `INSERT INTO memory_access_log (project, query, intent, result_json, latency_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      project,
      pack.query,
      pack.intent,
      JSON.stringify({
        mode: pack.mode,
        asOf: pack.asOf,
        recordedAt: pack.recordedAt,
        memoryIds: pack.memories.map((hit) => hit.memory?.id).filter(Boolean),
        claimVersionIds: pack.memories.map((hit) => hit.version?.id).filter(Boolean),
        episodeIds: pack.episodes.map((hit) => hit.id),
        estimatedTokens: pack.estimatedTokens,
      }),
      pack.latencyMs,
    ]
  );
}
