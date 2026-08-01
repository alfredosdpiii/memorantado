import type Database from "better-sqlite3";
import * as graphDb from "./graph.js";
import {
  cosineSimilarity,
  embedText as embedLocalText,
} from "../memory/localEmbedding.js";
import { embedText as embedConfiguredText } from "../memory/embedding.js";
import { reciprocalRankFusion } from "../memory/ranking.js";
import { logAccess, renderContext } from "./contextPack.js";
import { readStoredVector } from "./vectorStore.js";
import type {
  ClaimVersion,
  ContextPack,
  Episode,
  MemoryConflict,
  RetrievalHit,
  RetrievalMode,
  SemanticMemory,
} from "../memory/types.js";
import {
  estimateTokens,
  ftsQuery,
  inferIntent,
  mapClaimVersion,
  mapConflict,
  mapEpisode,
  mapMemory,
  MEMORY_WITH_LIFECYCLE_SELECT,
  overlapScore,
  type ClaimVersionRow,
  type EpisodeRow,
  type MemoryConflictRow,
  type SemanticMemoryRow,
} from "./hybridRows.js";
export type RetrievalOptions = {
  limit?: number;
  tokenBudget?: number;
  mode?: RetrievalMode;
  asOf?: string;
  recordedAt?: string;
};

const DEFAULT_LIMIT = 8;
const DEFAULT_TOKEN_BUDGET = 1800;
const MAX_RETRIEVAL_SCAN = 5000;
const MIN_VECTOR_RELEVANCE = 0.35;
export async function retrieveContext(
  db: Database.Database,
  project: string,
  query: string,
  opts: RetrievalOptions = {}
): Promise<ContextPack> {
  const start = Date.now();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const mode = opts.mode ?? "current";
  const asOf = opts.asOf ?? null;
  const recordedAt = opts.recordedAt ?? null;
  const memories = (
    await collectMemoryHits(db, project, query, limit * 3, {
      mode,
      asOf,
      recordedAt,
    })
  )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const episodes = (await collectEpisodeHits(db, project, query, limit * 2))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const conflicts = listOpenConflictsForHits(db, project, memories);
  const graph = graphDb.searchNodes(db, project, query);
  const context = renderContext(memories, episodes, conflicts, graph, tokenBudget);
  const pack: ContextPack = {
    query,
    intent: inferIntent(query),
    mode,
    asOf,
    recordedAt,
    memories,
    episodes,
    conflicts,
    graph,
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
async function collectMemoryHits(
  db: Database.Database,
  project: string,
  query: string,
  limit: number,
  temporal: {
    mode: RetrievalMode;
    asOf: string | null;
    recordedAt: string | null;
  }
): Promise<RetrievalHit[]> {
  if (temporal.mode !== "current") {
    return collectVersionHits(db, project, query, limit, temporal);
  }
  const queryEmbedding = await embedConfiguredText(query);
  const memories = listActiveMemories(db, project, MAX_RETRIEVAL_SCAN);
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const bm25 = searchMemoryFts(db, project, query, limit * 4);
  const vector = memories
    .map((memory) => ({
      id: memory.id,
      score: cosineSimilarity(
        queryEmbedding.vector,
        readStoredVector(
          db,
          "memory_embeddings",
          "memory_id",
          memory.id,
          queryEmbedding.provider
        ) ?? []
      ),
    }))
    .filter((entry) => entry.score >= MIN_VECTOR_RELEVANCE)
    .sort((left, right) => right.score - left.score || left.id - right.id);
  const overlap = memories
    .map((memory) => ({ id: memory.id, score: overlapScore(query, memory.content) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id - right.id);
  const candidateIds = new Set([
    ...bm25.map((entry) => entry.id),
    ...vector.map((entry) => entry.id),
    ...overlap.map((entry) => entry.id),
  ]);
  if (!candidateIds.size) return [];
  const prior = memories
    .filter((memory) => candidateIds.has(memory.id))
    .sort(
      (left, right) =>
        right.importance + right.confidence - (left.importance + left.confidence) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id - right.id
    );
  return reciprocalRankFusion([
    { name: "bm25", ids: bm25.map((entry) => entry.id) },
    { name: "vector", ids: vector.map((entry) => entry.id) },
    { name: "overlap", ids: overlap.map((entry) => entry.id) },
    { name: "prior", ids: prior.map((memory) => memory.id) },
  ])
    .slice(0, limit)
    .flatMap((fused) => {
      const memory = byId.get(fused.id);
      if (!memory) return [];
      return [
        {
          type: "memory" as const,
          id: memory.id,
          memory,
          sources: getMemorySources(db, memory.id),
          score: fused.score,
          scoreParts: Object.fromEntries(
            Object.entries(fused.ranks).map(([channel, rank]) => [channel, 1 / rank])
          ),
        },
      ];
    });
}
function collectVersionHits(
  db: Database.Database,
  project: string,
  query: string,
  limit: number,
  temporal: {
    mode: RetrievalMode;
    asOf: string | null;
    recordedAt: string | null;
  }
): RetrievalHit[] {
  const versions = listClaimVersionsForRetrieval(
    db,
    project,
    temporal,
    MAX_RETRIEVAL_SCAN
  );
  const byId = new Map(versions.map((version) => [version.id, version]));
  const bm25 = searchVersionFts(db, project, query, limit * 4).filter((entry) =>
    byId.has(entry.id)
  );
  const queryVector = embedLocalText(query);
  const vector = versions
    .map((version) => ({
      id: version.id,
      // Claim versions are embedded once at write time (and backfilled by
      // migration 4). The fallback keeps parity for any pre-existing row
      // that has no stored vector yet.
      score: cosineSimilarity(
        queryVector,
        readStoredVector(
          db,
          "claim_version_embeddings",
          "claim_version_id",
          version.id,
          "local-hash"
        ) ?? embedLocalText(version.content)
      ),
    }))
    .filter((entry) => entry.score >= MIN_VECTOR_RELEVANCE)
    .sort((left, right) => right.score - left.score || left.id - right.id);
  const overlap = versions
    .map((version) => ({ id: version.id, score: overlapScore(query, version.content) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id - right.id);
  const candidateIds = new Set([
    ...bm25.map((entry) => entry.id),
    ...vector.map((entry) => entry.id),
    ...overlap.map((entry) => entry.id),
  ]);
  if (!candidateIds.size) return [];
  const prior = versions
    .filter((version) => candidateIds.has(version.id))
    .sort(
      (left, right) =>
        right.importance + right.confidence - (left.importance + left.confidence) ||
        right.recordedAt.localeCompare(left.recordedAt) ||
        left.id - right.id
    );
  return reciprocalRankFusion([
    { name: "bm25", ids: bm25.map((entry) => entry.id) },
    { name: "vector", ids: vector.map((entry) => entry.id) },
    { name: "overlap", ids: overlap.map((entry) => entry.id) },
    { name: "prior", ids: prior.map((version) => version.id) },
  ])
    .slice(0, limit)
    .flatMap((fused) => {
      const version = byId.get(fused.id);
      if (!version) return [];
      return [
        {
          type: "claim_version" as const,
          id: version.id,
          version,
          sources: getVersionSources(db, version.id),
          score: fused.score,
          scoreParts: Object.fromEntries(
            Object.entries(fused.ranks).map(([channel, rank]) => [channel, 1 / rank])
          ),
        },
      ];
    });
}

function listClaimVersionsForRetrieval(
  db: Database.Database,
  project: string,
  temporal: {
    mode: RetrievalMode;
    asOf: string | null;
    recordedAt: string | null;
  },
  limit: number
): ClaimVersion[] {
  const clauses = ["project = ?"];
  const params: Array<string | number> = [project];
  if (temporal.recordedAt) {
    clauses.push("recorded_at <= ?", "(retracted_at IS NULL OR retracted_at > ?)");
    params.push(temporal.recordedAt, temporal.recordedAt);
  }
  if (temporal.mode === "as_of") {
    if (!temporal.asOf) throw new Error("asOf is required when mode is as_of");
    clauses.push("(valid_from IS NULL OR valid_from <= ?)");
    clauses.push("(valid_to IS NULL OR valid_to > ?)");
    params.push(temporal.asOf, temporal.asOf);
  } else if (temporal.mode === "history") {
    clauses.push("(valid_from IS NOT NULL OR valid_to IS NOT NULL)");
  }
  params.push(limit);
  return (
    db
      .prepare(
        `
        SELECT * FROM claim_versions
        WHERE ${clauses.join(" AND ")}
        ORDER BY recorded_at DESC, id DESC
        LIMIT ?
      `
      )
      .all(...params) as ClaimVersionRow[]
  ).map(mapClaimVersion);
}

function getVersionSources(db: Database.Database, versionId: number): Episode[] {
  return (
    db
      .prepare(
        `
        SELECT DISTINCT e.id, e.project, e.session, e.actor, e.role, e.content,
               e.source, e.metadata_json, e.created_at
        FROM memory_evidence me
        JOIN episodes e ON e.id = me.episode_id
        WHERE me.claim_version_id = ?
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 5
      `
      )
      .all(versionId) as EpisodeRow[]
  ).map(mapEpisode);
}

function searchVersionFts(
  db: Database.Database,
  project: string,
  query: string,
  limit: number
): Array<{ id: number; score: number }> {
  const match = ftsQuery(query);
  if (!match) return [];
  return db
    .prepare(
      `SELECT cv.id, bm25(claim_versions_fts) AS score
       FROM claim_versions_fts
       JOIN claim_versions cv ON cv.id = claim_versions_fts.rowid
       WHERE claim_versions_fts.project = ? AND claim_versions_fts MATCH ?
       ORDER BY score ASC, cv.id ASC LIMIT ?`
    )
    .all(project, match, limit) as Array<{ id: number; score: number }>;
}

async function collectEpisodeHits(
  db: Database.Database,
  project: string,
  query: string,
  limit: number
): Promise<RetrievalHit[]> {
  const queryEmbedding = await embedConfiguredText(query);
  const episodes = listRecentEpisodes(db, project, MAX_RETRIEVAL_SCAN);
  const byId = new Map(episodes.map((episode) => [episode.id, episode]));
  const bm25 = searchEpisodeFts(db, project, query, limit * 4);
  const vector = episodes
    .map((episode) => ({
      id: episode.id,
      score: cosineSimilarity(
        queryEmbedding.vector,
        readStoredVector(
          db,
          "episode_embeddings",
          "episode_id",
          episode.id,
          queryEmbedding.provider
        ) ?? []
      ),
    }))
    .filter((entry) => entry.score >= MIN_VECTOR_RELEVANCE)
    .sort((left, right) => right.score - left.score || left.id - right.id);
  const overlap = episodes
    .map((episode) => ({ id: episode.id, score: overlapScore(query, episode.content) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id - right.id);
  const candidateIds = new Set([
    ...bm25.map((entry) => entry.id),
    ...vector.map((entry) => entry.id),
    ...overlap.map((entry) => entry.id),
  ]);
  if (!candidateIds.size) return [];
  const prior = episodes
    .filter((episode) => candidateIds.has(episode.id))
    .sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || left.id - right.id
    );
  return reciprocalRankFusion([
    { name: "bm25", ids: bm25.map((entry) => entry.id) },
    { name: "vector", ids: vector.map((entry) => entry.id) },
    { name: "overlap", ids: overlap.map((entry) => entry.id) },
    { name: "prior", ids: prior.map((episode) => episode.id) },
  ])
    .slice(0, limit)
    .flatMap((fused) => {
      const episode = byId.get(fused.id);
      if (!episode) return [];
      return [
        {
          type: "episode" as const,
          id: episode.id,
          episode,
          score: fused.score,
          scoreParts: Object.fromEntries(
            Object.entries(fused.ranks).map(([channel, rank]) => [channel, 1 / rank])
          ),
        },
      ];
    });
}

function listActiveMemories(
  db: Database.Database,
  project: string,
  limit: number
): SemanticMemory[] {
  return (
    db
      .prepare(
        `${MEMORY_WITH_LIFECYCLE_SELECT}
         WHERE sm.project = ? AND sm.status = 'active'
           AND COALESCE(ml.status, 'active') = 'active'
         ORDER BY sm.importance DESC, sm.updated_at DESC
         LIMIT ?`
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
): Array<{ id: number; score: number }> {
  const match = ftsQuery(query);
  if (!match) return [];
  return db
    .prepare(
      `
      SELECT sm.id, bm25(semantic_memories_fts) AS score
      FROM semantic_memories_fts
      JOIN semantic_memories sm ON sm.id = semantic_memories_fts.rowid
      LEFT JOIN memory_lifecycle ml ON ml.memory_id = sm.id
      WHERE semantic_memories_fts.project = ? AND sm.status = 'active'
        AND COALESCE(ml.status, 'active') = 'active'
        AND semantic_memories_fts MATCH ?
      ORDER BY score ASC, sm.id ASC
      LIMIT ?
    `
    )
    .all(project, match, limit) as Array<{ id: number; score: number }>;
}

function searchEpisodeFts(
  db: Database.Database,
  project: string,
  query: string,
  limit: number
): Array<{ id: number; score: number }> {
  const match = ftsQuery(query);
  if (!match) return [];
  return db
    .prepare(
      `SELECT e.id, bm25(episodes_fts) AS score
       FROM episodes_fts
       JOIN episodes e ON e.id = episodes_fts.rowid
       WHERE episodes_fts.project = ? AND episodes_fts MATCH ?
       ORDER BY score ASC, e.id ASC LIMIT ?`
    )
    .all(project, match, limit) as Array<{ id: number; score: number }>;
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
