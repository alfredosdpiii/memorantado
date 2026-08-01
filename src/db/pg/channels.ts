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
// bm25 channel
//
// Replicates FTS5's bm25() scoring (sqlite3 ext/fts5) so the channel rank
// order matches the sqlite backend:
//   score(row) = sum over phrases of
//     idf * (freq * (k1+1)) / (freq + k1 * (1 - b + b * D / avgdl))
// with k1=1.2, b=0.75, idf = log((N - n + 0.5) / (n + 0.5)) clamped to 1e-6,
// D = total token instances in the row, and N/avgdl over the whole table
// (all projects/statuses, exactly like FTS5's docsize statistics). Documented
// deviations: tokens come from pg's 'english' configuration (stopwords are
// excluded from D/avgdl and phrase prefixes; FTS5's porter tokenizer indexes
// stopwords and stems slightly differently).
// ---------------------------------------------------------------------------

const BM25_K1 = 1.2;
const BM25_B = 0.75;

type FtsTable = "episodes" | "semantic_memories" | "claim_versions";

type Bm25Phrase = { prefix: string; idf: number };

async function bm25Phrases(
  db: Queryable,
  table: FtsTable,
  words: string[],
  rowCount: number
): Promise<Bm25Phrase[]> {
  const phrases: Bm25Phrase[] = [];
  for (const word of words) {
    // Doc frequency is whole-table (all projects/statuses), mirroring
    // FTS5's xQueryPhrase count.
    const { rows } = await db.query<{ tsq: string; n: number }>(
      `SELECT to_tsquery('english', $1)::text AS tsq,
              (SELECT count(*) FROM ${table}
               WHERE search_vector @@ to_tsquery('english', $1)) AS n`,
      [`'${word}':*`]
    );
    const prefix = parsePrefixTerm(rows[0].tsq);
    // null: the word is a stopword under the 'english' configuration and
    // was dropped from the query (documented deviation from FTS5).
    if (prefix === null) continue;
    const rawIdf = Math.log((rowCount - rows[0].n + 0.5) / (rows[0].n + 0.5));
    phrases.push({ prefix, idf: rawIdf <= 0 ? 1e-6 : rawIdf });
  }
  return phrases;
}

/** Parses pg's normalized `'stem':*` form back into the stemmed prefix. */
function parsePrefixTerm(tsqueryText: string): string | null {
  const match = /^'([^']+)':\*$/.exec(tsqueryText.trim());
  return match ? match[1] : null;
}

/**
 * Scores every row matching the GIN-filtered @@ predicate with FTS5's exact
 * bm25 formula (idf/avgdl are per-query constants; phrase frequencies and the
 * row's token count are computed per row in SQL), then keeps the top `limit`
 * by score with the id tie-break — the same channel rank list sqlite
 * produces with bm25() ASC, id ASC.
 */
async function bm25Channel(
  db: Queryable,
  table: FtsTable,
  filteredFromWhere: string,
  filterParams: unknown[],
  words: string[],
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  if (!words.length) return [];
  const stats = await db.query<{ row_count: number; token_count: number }>(
    `SELECT row_count, token_count FROM fts_stats WHERE table_name = $1`,
    [table]
  );
  const rowCount = stats.rows[0]?.row_count ?? 0;
  const tokenCount = stats.rows[0]?.token_count ?? 0;
  if (!rowCount || !tokenCount) return [];
  const avgdl = tokenCount / rowCount;
  const phrases = await bm25Phrases(db, table, words, rowCount);
  if (!phrases.length) return [];
  const tsquery = phrases.map((phrase) => `'${phrase.prefix}':*`).join(" | ");
  const prefixParams = phrases.map((phrase) => phrase.prefix);
  const freqColumns = phrases
    .map(
      (_, index) =>
        `tsvector_prefix_freq(t.search_vector, $${filterParams.length + 2 + index})::float8 ` +
        `AS f${index}`
    )
    .join(", ");
  const scoreTerms = phrases
    .map((phrase, index) => {
      const freq = `s.f${index}`;
      return (
        `(${phrase.idf} * (${freq} * ${BM25_K1 + 1}) / ` +
        `(${freq} + ${BM25_K1} * (1 - ${BM25_B} + ${BM25_B} * s.search_length / ${avgdl})))`
      );
    })
    .join(" + ");
  const { rows } = await db.query<{ id: number; score: number }>(
    `SELECT s.id, (${scoreTerms}) AS score
     FROM (
       SELECT t.id, t.search_length, ${freqColumns}
       FROM ${filteredFromWhere}
         AND t.search_vector @@ to_tsquery('english', $${filterParams.length + 1})
     ) s
     ORDER BY score DESC, s.id ASC
     LIMIT $${filterParams.length + 2 + phrases.length}`,
    [...filterParams, tsquery, ...prefixParams, limit]
  );
  return rows;
}

export async function searchMemoryFts(
  db: Queryable,
  project: string,
  words: string[],
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  return bm25Channel(
    db,
    "semantic_memories",
    `semantic_memories t
     LEFT JOIN memory_lifecycle ml ON ml.memory_id = t.id
     WHERE t.project = $1 AND t.status = 'active'
       AND COALESCE(ml.status, 'active') = 'active'`,
    [project],
    words,
    limit
  );
}

export async function searchEpisodeFts(
  db: Queryable,
  project: string,
  words: string[],
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  return bm25Channel(
    db,
    "episodes",
    `episodes t WHERE t.project = $1`,
    [project],
    words,
    limit
  );
}

export async function searchVersionFts(
  db: Queryable,
  project: string,
  words: string[],
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  return bm25Channel(
    db,
    "claim_versions",
    `claim_versions t WHERE t.project = $1`,
    [project],
    words,
    limit
  );
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
