import type { Graph, GraphEntity, GraphRelation } from "./graph.js";
import type { MemoryItem } from "./timeline.js";
import type { AppendEpisodeInput } from "./hybridMemory.js";
import type { RetrievalOptions } from "./hybridRetrieval.js";
import type { MemoryExplanation } from "./temporalMemory.js";
import type { RetrievalEvaluationResult } from "../bench/memoryEvaluation.js";
import type { EmbeddingBackfillResult } from "../memory/embeddingBackfill.js";
import type {
  CandidateMemory,
  ContextPack,
  Episode,
  MemoryConflict,
  SemanticMemory,
} from "../memory/types.js";

export type StoreKind = "sqlite" | "pg";

/**
 * Backend-agnostic storage facade.
 *
 * This interface captures the exact module-function surface that consumers
 * (REST routes, MCP server, benchmark harness, wiki projection, exchange
 * import/export) used to import from src/db/* when better-sqlite3 was the
 * only backend. SqliteStore delegates to those modules unchanged; PgStore
 * reimplements the same semantics on Postgres + pgvector.
 *
 * All methods are async so both backends share one call shape; the sqlite
 * implementation is a thin async facade over the existing sync internals.
 */
export interface MemoryStore {
  readonly kind: StoreKind;

  close(): Promise<void>;

  // Knowledge graph (src/db/graph.ts)
  createEntities(
    project: string,
    entities: Array<{ name: string; entityType: string; observations?: string[] }>
  ): Promise<GraphEntity[]>;
  createRelations(
    project: string,
    relations: Array<{ from: string; to: string; relationType: string }>
  ): Promise<GraphRelation[]>;
  addObservations(
    project: string,
    observations: Array<{ entityName: string; contents: string[] }>
  ): Promise<Array<{ entityName: string; addedObservations: string[] }>>;
  deleteEntities(project: string, entityNames: string[]): Promise<void>;
  deleteObservations(
    project: string,
    deletions: Array<{ entityName: string; observations: string[] }>
  ): Promise<void>;
  deleteRelations(
    project: string,
    relations: Array<{ from: string; to: string; relationType: string }>
  ): Promise<void>;
  readGraph(project: string): Promise<Graph>;
  searchNodes(project: string, query: string): Promise<Graph>;
  openNodes(project: string, names: string[]): Promise<Graph>;
  getEntityByName(
    project: string,
    name: string
  ): Promise<(GraphEntity & { id: number; relations: GraphRelation[] }) | null>;
  deleteObservationById(id: number): Promise<void>;
  deleteRelationById(id: number): Promise<void>;
  createRelationDirect(
    project: string,
    from: string,
    to: string,
    relationType: string
  ): Promise<{ id: number } | null>;

  // Memory timeline (src/db/timeline.ts)
  appendMemoryItem(
    project: string,
    item: {
      kind: string;
      title?: string;
      content: string;
      tags?: string[];
      source?: string;
    }
  ): Promise<MemoryItem>;
  getMemoryItem(project: string, id: number): Promise<MemoryItem | null>;
  deleteMemoryItem(project: string, id: number): Promise<boolean>;
  searchMemoryItems(
    project: string,
    query: string,
    opts?: { kind?: string; limit?: number; offset?: number }
  ): Promise<MemoryItem[]>;
  listMemoryItems(
    project: string,
    opts?: { kind?: string; limit?: number; offset?: number }
  ): Promise<MemoryItem[]>;
  getProjects(): Promise<string[]>;

  // Hybrid memory (src/db/hybridMemory.ts, src/db/temporalMemory.ts)
  appendEpisode(project: string, input: AppendEpisodeInput): Promise<Episode>;
  getEpisode(project: string, id: number): Promise<Episode | null>;
  listEpisodes(
    project: string,
    opts?: { limit?: number; offset?: number; session?: string }
  ): Promise<Episode[]>;
  upsertSemanticMemory(
    project: string,
    input: CandidateMemory,
    sourceEpisodeId?: number,
    evidence?: { quote?: string; spanStart?: number }
  ): Promise<SemanticMemory>;
  extractMemories(project: string, episodeId: number): Promise<SemanticMemory[]>;
  listSemanticMemories(
    project: string,
    opts?: {
      status?: string;
      lifecycleStatus?: "active" | "archived";
      limit?: number;
      offset?: number;
    }
  ): Promise<SemanticMemory[]>;
  setMemoryLifecycle(
    project: string,
    memoryId: number,
    status: "active" | "archived",
    reason?: string
  ): Promise<SemanticMemory | null>;
  explainMemory(project: string, memoryId: number): Promise<MemoryExplanation>;
  listConflicts(project: string, status?: string): Promise<MemoryConflict[]>;
  resolveConflict(
    project: string,
    conflictId: number,
    resolvedMemoryId?: number,
    status?: "resolved" | "ignored",
    audit?: {
      actor?: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<MemoryConflict | null>;
  retrieveContext(
    project: string,
    query: string,
    opts?: RetrievalOptions
  ): Promise<ContextPack>;
  runMemoryBenchmark(project: string, topK?: number): Promise<RetrievalEvaluationResult>;

  // Exchange (src/db/exchange.ts)
  exportProjectJsonl(project: string): Promise<string>;
  importProjectJsonl(
    jsonl: string,
    projectOverride?: string
  ): Promise<{ project: string; imported: Record<string, number> }>;

  // Embeddings (src/memory/embeddingBackfill.ts)
  backfillConfiguredEmbeddings(project: string): Promise<EmbeddingBackfillResult>;

  // Wiki projection state (src/wiki/obsidian.ts)
  replaceWikiProjectionState(
    project: string,
    entries: Array<{
      path: string;
      revision: string;
      contentHash: string;
      generatedAt: string;
    }>
  ): Promise<void>;
  wikiProjectionStateCount(project: string): Promise<number>;

  // Benchmark persistence + fixture normalization (src/bench/memoryEvaluation.ts)
  insertBenchmarkRun(
    project: string,
    name: string,
    metricsJson: string,
    report: string
  ): Promise<number>;
  readLatestBenchmarkMetrics(project: string, name: string): Promise<string | null>;
  normalizeBenchmarkTimestamps(project: string, timestamp: string): Promise<void>;
}

export function resolveStoreKind(env: NodeJS.ProcessEnv = process.env): StoreKind {
  const raw = env.MEMORANTADO_STORE?.trim().toLowerCase();
  if (!raw || raw === "sqlite") return "sqlite";
  if (raw === "pg" || raw === "postgres" || raw === "postgresql") return "pg";
  throw new Error(`unsupported MEMORANTADO_STORE: ${raw} (expected "sqlite" or "pg")`);
}

/**
 * Opens the configured storage backend. SQLite (better-sqlite3) is the
 * default; Postgres + pgvector is opt-in via MEMORANTADO_STORE=pg plus
 * MEMORANTADO_DATABASE_URL.
 */
export async function openStore(opts: { dbPath?: string } = {}): Promise<MemoryStore> {
  if (resolveStoreKind() === "pg") {
    const databaseUrl = process.env.MEMORANTADO_DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("MEMORANTADO_DATABASE_URL is required when MEMORANTADO_STORE=pg");
    }
    const { createPgStore } = await import("./pg/pgStore.js");
    return createPgStore(databaseUrl);
  }
  const { SqliteStore } = await import("./sqliteStore.js");
  return SqliteStore.create(opts.dbPath);
}
