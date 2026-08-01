import { embedText as embedConfiguredText } from "../../memory/embedding.js";
import { reciprocalRankFusion } from "../../memory/ranking.js";
import { renderContext } from "../contextPack.js";
import { estimateTokens, inferIntent, overlapScore } from "../hybridRows.js";
import type { ContextPack, RetrievalHit, RetrievalMode } from "../../memory/types.js";
import type { Queryable } from "./client.js";
import {
  exactEpisodeVectorScan,
  exactMemoryVectorScan,
  fetchEpisodesByIds,
  fetchMemoriesByIds,
  ftsWords,
  getMemorySourcesPg,
  getVersionSourcesPg,
  knnClaimVersionIds,
  knnEpisodeIds,
  knnMemoryIds,
  listClaimVersionsForRetrieval,
  listOpenConflictsForHits,
  logAccessPg,
  searchEpisodeFts,
  searchMemoryFts,
  searchVersionFts,
  toPrefixTsquery,
  type PgTemporalFilter,
} from "./channels.js";
import { searchNodesPg } from "./graphSearch.js";
import type { RetrievalOptions } from "../hybridRetrieval.js";

const DEFAULT_LIMIT = 8;
const DEFAULT_TOKEN_BUDGET = 1800;
// Temporal as_of/history/all modes are rare audit queries and keep a bounded
// scan; the cap is lifted from sqlite's 5000 to an honest 100k. Current-mode
// retrieval has no scan at all (index-backed bm25 + KNN candidates).
const MAX_TEMPORAL_SCAN = 100_000;

export { toPrefixTsquery };
export type { PgTemporalFilter };

export async function retrieveContextPg(
  db: Queryable,
  project: string,
  query: string,
  opts: RetrievalOptions = {}
): Promise<ContextPack> {
  const start = Date.now();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const mode: RetrievalMode = opts.mode ?? "current";
  const asOf = opts.asOf ?? null;
  const recordedAt = opts.recordedAt ?? null;
  const memories = (
    await collectMemoryHits(db, project, query, limit * 3, { mode, asOf, recordedAt })
  )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const episodes = (await collectEpisodeHits(db, project, query, limit * 2))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const conflicts = await listOpenConflictsForHits(db, project, memories);
  const graph = await searchNodesPg(db, project, query);
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
  await logAccessPg(db, project, pack);
  return pack;
}

async function collectMemoryHits(
  db: Queryable,
  project: string,
  query: string,
  limit: number,
  temporal: PgTemporalFilter
): Promise<RetrievalHit[]> {
  if (temporal.mode !== "current") {
    return collectVersionHits(db, project, query, limit, temporal);
  }
  const queryEmbedding = await embedConfiguredText(query);
  const tsquery = toPrefixTsquery(ftsWords(query));
  const bm25 = tsquery ? await searchMemoryFts(db, project, tsquery, limit * 4) : [];
  const vector =
    queryEmbedding.provider === "local-hash"
      ? await knnMemoryIds(db, project, queryEmbedding.vector, Math.max(limit * 4, 64))
      : await exactMemoryVectorScan(db, project, queryEmbedding);
  // Candidates are the bounded union of the bm25 and vector channels. The
  // overlap and prior channels are computed over those candidates instead of
  // scanning the whole project; this is semantics-preserving because any row
  // with nonzero lexical overlap also matches the prefix FTS query (bar the
  // documented edge case where more than limit*4 rows share query tokens).
  const candidateIds = new Set<number>([
    ...bm25.map((entry) => entry.id),
    ...vector.map((entry) => entry.id),
  ]);
  if (!candidateIds.size) return [];
  const memories = await fetchMemoriesByIds(db, [...candidateIds]);
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const overlap = memories
    .map((memory) => ({ id: memory.id, score: overlapScore(query, memory.content) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id - right.id);
  const prior = [...memories].sort(
    (left, right) =>
      right.importance + right.confidence - (left.importance + left.confidence) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id - right.id
  );
  const fused = reciprocalRankFusion([
    { name: "bm25", ids: bm25.map((entry) => entry.id) },
    { name: "vector", ids: vector.map((entry) => entry.id) },
    { name: "overlap", ids: overlap.map((entry) => entry.id) },
    { name: "prior", ids: prior.map((memory) => memory.id) },
  ]).slice(0, limit);
  // Sequential on purpose: all queries share one connection (and one
  // transaction) inside retrieveContext; concurrent queries on a single pg
  // client are deprecated.
  const hits: RetrievalHit[] = [];
  for (const entry of fused) {
    const memory = byId.get(entry.id);
    if (!memory) continue;
    hits.push({
      type: "memory",
      id: memory.id,
      memory,
      sources: await getMemorySourcesPg(db, memory.id),
      score: entry.score,
      scoreParts: Object.fromEntries(
        Object.entries(entry.ranks).map(([channel, rank]) => [channel, 1 / rank])
      ),
    });
  }
  return hits;
}

async function collectVersionHits(
  db: Queryable,
  project: string,
  query: string,
  limit: number,
  temporal: PgTemporalFilter
): Promise<RetrievalHit[]> {
  const versions = await listClaimVersionsForRetrieval(
    db,
    project,
    temporal,
    MAX_TEMPORAL_SCAN
  );
  const byId = new Map(versions.map((version) => [version.id, version]));
  const tsquery = toPrefixTsquery(ftsWords(query));
  const bm25 = (
    tsquery ? await searchVersionFts(db, project, tsquery, limit * 4) : []
  ).filter((entry) => byId.has(entry.id));
  const vector = (
    await knnClaimVersionIds(db, project, query, temporal, Math.max(limit * 4, 64))
  ).filter((entry) => byId.has(entry.id));
  const candidateIds = new Set<number>([
    ...bm25.map((entry) => entry.id),
    ...vector.map((entry) => entry.id),
  ]);
  if (!candidateIds.size) return [];
  const candidates = versions.filter((version) => candidateIds.has(version.id));
  const overlap = candidates
    .map((version) => ({ id: version.id, score: overlapScore(query, version.content) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id - right.id);
  const prior = [...candidates].sort(
    (left, right) =>
      right.importance + right.confidence - (left.importance + left.confidence) ||
      right.recordedAt.localeCompare(left.recordedAt) ||
      left.id - right.id
  );
  const fused = reciprocalRankFusion([
    { name: "bm25", ids: bm25.map((entry) => entry.id) },
    { name: "vector", ids: vector.map((entry) => entry.id) },
    { name: "overlap", ids: overlap.map((entry) => entry.id) },
    { name: "prior", ids: prior.map((version) => version.id) },
  ]).slice(0, limit);
  const hits: RetrievalHit[] = [];
  for (const entry of fused) {
    const version = byId.get(entry.id);
    if (!version) continue;
    hits.push({
      type: "claim_version",
      id: version.id,
      version,
      sources: await getVersionSourcesPg(db, version.id),
      score: entry.score,
      scoreParts: Object.fromEntries(
        Object.entries(entry.ranks).map(([channel, rank]) => [channel, 1 / rank])
      ),
    });
  }
  return hits;
}

async function collectEpisodeHits(
  db: Queryable,
  project: string,
  query: string,
  limit: number
): Promise<RetrievalHit[]> {
  const queryEmbedding = await embedConfiguredText(query);
  const tsquery = toPrefixTsquery(ftsWords(query));
  const bm25 = tsquery ? await searchEpisodeFts(db, project, tsquery, limit * 4) : [];
  const vector =
    queryEmbedding.provider === "local-hash"
      ? await knnEpisodeIds(db, project, queryEmbedding.vector, Math.max(limit * 4, 64))
      : await exactEpisodeVectorScan(db, project, queryEmbedding);
  const candidateIds = new Set<number>([
    ...bm25.map((entry) => entry.id),
    ...vector.map((entry) => entry.id),
  ]);
  if (!candidateIds.size) return [];
  const episodes = await fetchEpisodesByIds(db, [...candidateIds]);
  const byId = new Map(episodes.map((episode) => [episode.id, episode]));
  const overlap = episodes
    .map((episode) => ({ id: episode.id, score: overlapScore(query, episode.content) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id - right.id);
  const prior = [...episodes].sort(
    (left, right) => right.createdAt.localeCompare(left.createdAt) || left.id - right.id
  );
  const fused = reciprocalRankFusion([
    { name: "bm25", ids: bm25.map((entry) => entry.id) },
    { name: "vector", ids: vector.map((entry) => entry.id) },
    { name: "overlap", ids: overlap.map((entry) => entry.id) },
    { name: "prior", ids: prior.map((episode) => episode.id) },
  ]).slice(0, limit);
  return fused.flatMap((entry) => {
    const episode = byId.get(entry.id);
    if (!episode) return [];
    return [
      {
        type: "episode" as const,
        id: episode.id,
        episode,
        score: entry.score,
        scoreParts: Object.fromEntries(
          Object.entries(entry.ranks).map(([channel, rank]) => [channel, 1 / rank])
        ),
      },
    ];
  });
}
