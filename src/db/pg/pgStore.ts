import { runRetrievalEvaluation } from "../../bench/memoryEvaluation.js";
import type { MemoryStore, StoreKind } from "../store.js";
import { createPool, type Pool } from "./client.js";
import { ensurePgSchema } from "./schema.js";
import { retrieveContextPg } from "./retrieval.js";
import { searchNodesPg } from "./graphSearch.js";
import {
  addObservationsPg,
  createEntitiesPg,
  createRelationDirectPg,
  createRelationsPg,
  deleteEntitiesPg,
  deleteObservationByIdPg,
  deleteObservationsPg,
  deleteRelationByIdPg,
  deleteRelationsPg,
  getEntityByNamePg,
  openNodesPg,
  readGraphPg,
} from "./graphOps.js";
import {
  appendMemoryItemPg,
  deleteMemoryItemPg,
  getMemoryItemPg,
  getProjectsPg,
  listMemoryItemsPg,
  searchMemoryItemsPg,
} from "./timelineOps.js";
import {
  appendEpisodePg,
  explainMemoryPg,
  extractMemoriesPg,
  getEpisodePg,
  listConflictsPg,
  listEpisodesPg,
  listSemanticMemoriesPg,
  resolveConflictPg,
  setMemoryLifecyclePg,
  upsertSemanticMemoryPg,
} from "./hybridOps.js";
import { backfillConfiguredEmbeddingsPg } from "./embeddingOps.js";
import { exportProjectJsonlPg, importProjectJsonlPg } from "./exchangeOps.js";
import {
  insertBenchmarkRunPg,
  normalizeBenchmarkTimestampsPg,
  readLatestBenchmarkMetricsPg,
  replaceWikiProjectionStatePg,
  wikiProjectionStateCountPg,
} from "./miscOps.js";

export async function createPgStore(databaseUrl: string): Promise<PgStore> {
  const pool = createPool(databaseUrl);
  try {
    await ensurePgSchema(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  return new PgStore(pool, databaseUrl);
}

/**
 * Postgres + pgvector backend. Every method is a thin delegate to a focused
 * ops module; the class exists to satisfy the MemoryStore interface and own
 * the connection pool lifecycle.
 */
export class PgStore implements MemoryStore {
  readonly kind: StoreKind = "pg";

  constructor(
    private readonly pool: Pool,
    private readonly databaseUrl: string
  ) {}

  async close(): Promise<void> {
    await this.pool.end();
  }

  // knowledge graph
  createEntities: MemoryStore["createEntities"] = (project, entities) =>
    createEntitiesPg(this.pool, project, entities);
  createRelations: MemoryStore["createRelations"] = (project, relations) =>
    createRelationsPg(this.pool, project, relations);
  addObservations: MemoryStore["addObservations"] = (project, observations) =>
    addObservationsPg(this.pool, project, observations);
  deleteEntities: MemoryStore["deleteEntities"] = (project, entityNames) =>
    deleteEntitiesPg(this.pool, project, entityNames);
  deleteObservations: MemoryStore["deleteObservations"] = (project, deletions) =>
    deleteObservationsPg(this.pool, project, deletions);
  deleteRelations: MemoryStore["deleteRelations"] = (project, relations) =>
    deleteRelationsPg(this.pool, project, relations);
  readGraph: MemoryStore["readGraph"] = (project) => readGraphPg(this.pool, project);
  searchNodes: MemoryStore["searchNodes"] = (project, query) =>
    searchNodesPg(this.pool, project, query);
  openNodes: MemoryStore["openNodes"] = (project, names) =>
    openNodesPg(this.pool, project, names);
  getEntityByName: MemoryStore["getEntityByName"] = (project, name) =>
    getEntityByNamePg(this.pool, project, name);
  deleteObservationById: MemoryStore["deleteObservationById"] = (id) =>
    deleteObservationByIdPg(this.pool, id);
  deleteRelationById: MemoryStore["deleteRelationById"] = (id) =>
    deleteRelationByIdPg(this.pool, id);
  createRelationDirect: MemoryStore["createRelationDirect"] = (
    project,
    from,
    to,
    relationType
  ) => createRelationDirectPg(this.pool, project, from, to, relationType);

  // memory timeline
  appendMemoryItem: MemoryStore["appendMemoryItem"] = (project, item) =>
    appendMemoryItemPg(this.pool, project, item);
  getMemoryItem: MemoryStore["getMemoryItem"] = (project, id) =>
    getMemoryItemPg(this.pool, project, id);
  deleteMemoryItem: MemoryStore["deleteMemoryItem"] = (project, id) =>
    deleteMemoryItemPg(this.pool, project, id);
  searchMemoryItems: MemoryStore["searchMemoryItems"] = (project, query, opts) =>
    searchMemoryItemsPg(this.pool, project, query, opts);
  listMemoryItems: MemoryStore["listMemoryItems"] = (project, opts) =>
    listMemoryItemsPg(this.pool, project, opts);
  getProjects: MemoryStore["getProjects"] = () => getProjectsPg(this.pool);

  // hybrid memory
  appendEpisode: MemoryStore["appendEpisode"] = (project, input) =>
    appendEpisodePg(this.pool, project, input);
  getEpisode: MemoryStore["getEpisode"] = (project, id) =>
    getEpisodePg(this.pool, project, id);
  listEpisodes: MemoryStore["listEpisodes"] = (project, opts) =>
    listEpisodesPg(this.pool, project, opts);
  upsertSemanticMemory: MemoryStore["upsertSemanticMemory"] = (
    project,
    input,
    sourceEpisodeId,
    evidence
  ) => upsertSemanticMemoryPg(this.pool, project, input, sourceEpisodeId, evidence);
  extractMemories: MemoryStore["extractMemories"] = (project, episodeId) =>
    extractMemoriesPg(this.pool, project, episodeId);
  listSemanticMemories: MemoryStore["listSemanticMemories"] = (project, opts) =>
    listSemanticMemoriesPg(this.pool, project, opts);
  setMemoryLifecycle: MemoryStore["setMemoryLifecycle"] = (
    project,
    memoryId,
    status,
    reason
  ) => setMemoryLifecyclePg(this.pool, project, memoryId, status, reason);
  explainMemory: MemoryStore["explainMemory"] = (project, memoryId) =>
    explainMemoryPg(this.pool, project, memoryId);
  listConflicts: MemoryStore["listConflicts"] = (project, status) =>
    listConflictsPg(this.pool, project, status);
  resolveConflict: MemoryStore["resolveConflict"] = (
    project,
    conflictId,
    resolvedMemoryId,
    status,
    audit
  ) => resolveConflictPg(this.pool, project, conflictId, resolvedMemoryId, status, audit);

  retrieveContext: MemoryStore["retrieveContext"] = async (project, query, opts) => {
    const client = await this.pool.connect();
    try {
      // Single transaction: consistent snapshot across channels and a
      // statement-scoped HNSW search depth (SET LOCAL requires a transaction).
      await client.query("BEGIN");
      await client.query("SET LOCAL hnsw.ef_search = 64");
      const pack = await retrieveContextPg(client, project, query, opts);
      await client.query("COMMIT");
      return pack;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  runMemoryBenchmark: MemoryStore["runMemoryBenchmark"] = async (project, topK) => {
    const { createScratchPgStore } = await import("./admin.js");
    const scratch = await createScratchPgStore(this.databaseUrl);
    try {
      return await runRetrievalEvaluation(this, scratch.store, project, topK);
    } finally {
      await scratch.cleanup();
    }
  };

  // exchange
  exportProjectJsonl: MemoryStore["exportProjectJsonl"] = (project) =>
    exportProjectJsonlPg(this.pool, project);
  importProjectJsonl: MemoryStore["importProjectJsonl"] = (jsonl, projectOverride) =>
    importProjectJsonlPg(this.pool, jsonl, projectOverride);

  // embeddings
  backfillConfiguredEmbeddings: MemoryStore["backfillConfiguredEmbeddings"] = (project) =>
    backfillConfiguredEmbeddingsPg(this.pool, project);

  // wiki projection state
  replaceWikiProjectionState: MemoryStore["replaceWikiProjectionState"] = (
    project,
    entries
  ) => replaceWikiProjectionStatePg(this.pool, project, entries);
  wikiProjectionStateCount: MemoryStore["wikiProjectionStateCount"] = (project) =>
    wikiProjectionStateCountPg(this.pool, project);

  // benchmark persistence + fixture normalization
  insertBenchmarkRun: MemoryStore["insertBenchmarkRun"] = (
    project,
    name,
    metricsJson,
    report
  ) => insertBenchmarkRunPg(this.pool, project, name, metricsJson, report);
  readLatestBenchmarkMetrics: MemoryStore["readLatestBenchmarkMetrics"] = (
    project,
    name
  ) => readLatestBenchmarkMetricsPg(this.pool, project, name);
  normalizeBenchmarkTimestamps: MemoryStore["normalizeBenchmarkTimestamps"] = (
    project,
    timestamp
  ) => normalizeBenchmarkTimestampsPg(this.pool, project, timestamp);
}
