import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { migrate } from "./migrate.js";
import * as exchange from "./exchange.js";
import { upsertConfiguredEmbedding } from "./embeddingStore.js";
import * as graph from "./graph.js";
import * as hybrid from "./hybridMemory.js";
import * as curation from "./memoryCuration.js";
import * as conflicts from "./memoryConflicts.js";
import * as timeline from "./timeline.js";
import { runRetrievalEvaluation } from "../bench/memoryEvaluation.js";
import { backfillConfiguredEmbeddings } from "../memory/embeddingBackfill.js";
import type { MemoryStore, StoreKind } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Method<Name extends keyof MemoryStore> = MemoryStore[Name];

/**
 * Async facade over the existing sync better-sqlite3 modules. Behavior is
 * byte-for-byte identical to direct module usage; methods simply delegate.
 */
export class SqliteStore implements MemoryStore {
  readonly kind: StoreKind = "sqlite";

  private constructor(private readonly db: Database.Database) {}

  static create(dbPath?: string): SqliteStore {
    const db = openDb(dbPath);
    migrate(db);
    return new SqliteStore(db);
  }

  /**
   * Isolated in-memory fixture database used by the deterministic retrieval
   * benchmark. Mirrors the historical harness: schema only, no migrations.
   */
  static createIsolated(): SqliteStore {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    return new SqliteStore(db);
  }

  raw(): Database.Database {
    return this.db;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  createEntities: Method<"createEntities"> = async (project, entities) =>
    graph.createEntities(this.db, project, entities);
  createRelations: Method<"createRelations"> = async (project, relations) =>
    graph.createRelations(this.db, project, relations);
  addObservations: Method<"addObservations"> = async (project, observations) =>
    graph.addObservations(this.db, project, observations);
  deleteEntities: Method<"deleteEntities"> = async (project, entityNames) =>
    graph.deleteEntities(this.db, project, entityNames);
  deleteObservations: Method<"deleteObservations"> = async (project, deletions) =>
    graph.deleteObservations(this.db, project, deletions);
  deleteRelations: Method<"deleteRelations"> = async (project, relations) =>
    graph.deleteRelations(this.db, project, relations);
  readGraph: Method<"readGraph"> = async (project) => graph.readGraph(this.db, project);
  searchNodes: Method<"searchNodes"> = async (project, query) =>
    graph.searchNodes(this.db, project, query);
  openNodes: Method<"openNodes"> = async (project, names) =>
    graph.openNodes(this.db, project, names);
  getEntityByName: Method<"getEntityByName"> = async (project, name) =>
    graph.getEntityByName(this.db, project, name);
  deleteObservationById: Method<"deleteObservationById"> = async (id) =>
    graph.deleteObservationById(this.db, id);
  deleteRelationById: Method<"deleteRelationById"> = async (id) =>
    graph.deleteRelationById(this.db, id);
  createRelationDirect: Method<"createRelationDirect"> = async (
    project,
    from,
    to,
    relationType
  ) => graph.createRelationDirect(this.db, project, from, to, relationType);

  appendMemoryItem: Method<"appendMemoryItem"> = async (project, item) =>
    timeline.appendMemoryItem(this.db, project, item);
  getMemoryItem: Method<"getMemoryItem"> = async (project, id) =>
    timeline.getMemoryItem(this.db, project, id);
  deleteMemoryItem: Method<"deleteMemoryItem"> = async (project, id) =>
    timeline.deleteMemoryItem(this.db, project, id);
  searchMemoryItems: Method<"searchMemoryItems"> = async (project, query, opts) =>
    timeline.searchMemoryItems(this.db, project, query, opts);
  listMemoryItems: Method<"listMemoryItems"> = async (project, opts) =>
    timeline.listMemoryItems(this.db, project, opts);
  getProjects: Method<"getProjects"> = async () => timeline.getProjects(this.db);

  appendEpisode: Method<"appendEpisode"> = async (project, input) => {
    const episode = hybrid.appendEpisode(this.db, project, input);
    await upsertConfiguredEmbedding(this.db, "episode", episode.id, episode.content);
    return episode;
  };
  getEpisode: Method<"getEpisode"> = async (project, id) =>
    hybrid.getEpisode(this.db, project, id);
  listEpisodes: Method<"listEpisodes"> = async (project, opts) =>
    hybrid.listEpisodes(this.db, project, opts);
  upsertSemanticMemory: Method<"upsertSemanticMemory"> = async (
    project,
    input,
    sourceEpisodeId,
    evidence
  ) =>
    this.embedded(
      hybrid.upsertSemanticMemory(this.db, project, input, sourceEpisodeId, evidence)
    );
  extractMemories: Method<"extractMemories"> = async (project, episodeId) => {
    const memories = await hybrid.extractMemories(this.db, project, episodeId);
    for (const memory of memories) await this.embedded(memory);
    return memories;
  };
  listSemanticMemories: Method<"listSemanticMemories"> = async (project, opts) =>
    curation.listSemanticMemories(this.db, project, opts);
  getSemanticMemory: Method<"getSemanticMemory"> = async (project, memoryId) =>
    hybrid.getMemory(this.db, project, memoryId);
  getSemanticMemoryByKey: Method<"getSemanticMemoryByKey"> = async (project, key) =>
    hybrid.getMemoryByKey(this.db, project, key);
  supersedeMemory: Method<"supersedeMemory"> = async (
    project,
    memoryId,
    input,
    evidence
  ) => {
    const memory = hybrid.supersedeMemory(this.db, project, memoryId, input, evidence);
    return memory && this.embedded(memory);
  };

  private async embedded<T extends { id: number; content: string }>(
    memory: T
  ): Promise<T> {
    await upsertConfiguredEmbedding(this.db, "memory", memory.id, memory.content);
    return memory;
  }
  confirmMemory: Method<"confirmMemory"> = async (project, memoryId, evidence) =>
    curation.confirmMemory(this.db, project, memoryId, evidence);
  invalidateMemory: Method<"invalidateMemory"> = async (project, memoryId, reason) =>
    curation.invalidateMemory(this.db, project, memoryId, reason);
  deleteSemanticMemory: Method<"deleteSemanticMemory"> = async (project, memoryId) =>
    curation.deleteSemanticMemory(this.db, project, memoryId);
  createConflict: Method<"createConflict"> = async (
    project,
    memoryId,
    conflictingId,
    reason
  ) => curation.flagConflict(this.db, project, memoryId, conflictingId, reason);
  recordFileSnapshot: Method<"recordFileSnapshot"> = async (project, input) =>
    curation.recordFileSnapshot(this.db, project, input);
  findStaleFileEvidence: Method<"findStaleFileEvidence"> = async (project, files) =>
    curation.findStaleFileEvidence(this.db, project, files);
  setMemoryLifecycle: Method<"setMemoryLifecycle"> = async (
    project,
    memoryId,
    status,
    reason
  ) => curation.setMemoryLifecycle(this.db, project, memoryId, status, reason);
  explainMemory: Method<"explainMemory"> = async (project, memoryId) =>
    hybrid.explainMemory(this.db, project, memoryId);
  listConflicts: Method<"listConflicts"> = async (project, status) =>
    conflicts.listConflicts(this.db, project, status);
  resolveConflict: Method<"resolveConflict"> = async (
    project,
    conflictId,
    resolvedMemoryId,
    status,
    audit
  ) =>
    conflicts.resolveConflict(
      this.db,
      project,
      conflictId,
      resolvedMemoryId,
      status,
      audit
    );
  retrieveContext: Method<"retrieveContext"> = async (project, query, opts) =>
    hybrid.retrieveContext(this.db, project, query, opts);
  runMemoryBenchmark: Method<"runMemoryBenchmark"> = async (project, topK) => {
    const scratch = SqliteStore.createIsolated();
    try {
      return await runRetrievalEvaluation(this, scratch, project, topK);
    } finally {
      await scratch.close();
    }
  };

  exportProjectJsonl: Method<"exportProjectJsonl"> = async (project) =>
    exchange.exportProjectJsonl(this.db, project);
  importProjectJsonl: Method<"importProjectJsonl"> = async (jsonl, projectOverride) =>
    exchange.importProjectJsonl(this.db, jsonl, projectOverride);

  backfillConfiguredEmbeddings: Method<"backfillConfiguredEmbeddings"> = async (
    project
  ) => backfillConfiguredEmbeddings(this.db, project);

  replaceWikiProjectionState: Method<"replaceWikiProjectionState"> = async (
    project,
    entries
  ) => {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM wiki_projection_state WHERE project = ?").run(project);
      const insert = this.db.prepare(
        `INSERT INTO wiki_projection_state (project, path, revision, content_hash, generated_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const entry of entries) {
        insert.run(
          project,
          entry.path,
          entry.revision,
          entry.contentHash,
          entry.generatedAt
        );
      }
    })();
  };
  wikiProjectionStateCount: Method<"wikiProjectionStateCount"> = async (project) => {
    const row = this.db
      .prepare("SELECT count(*) AS count FROM wiki_projection_state WHERE project = ?")
      .get(project) as { count: number };
    return row.count;
  };

  insertBenchmarkRun: Method<"insertBenchmarkRun"> = async (
    project,
    name,
    metricsJson,
    report
  ) => {
    const row = this.db
      .prepare(
        `INSERT INTO benchmark_runs (project, name, metrics_json, report)
         VALUES (?, ?, ?, ?) RETURNING id`
      )
      .get(project, name, metricsJson, report) as { id: number };
    return row.id;
  };
  readLatestBenchmarkMetrics: Method<"readLatestBenchmarkMetrics"> = async (
    project,
    name
  ) => {
    const row = this.db
      .prepare(
        `SELECT metrics_json FROM benchmark_runs
         WHERE project = ? AND name = ? ORDER BY id DESC LIMIT 1`
      )
      .get(project, name) as { metrics_json: string } | undefined;
    return row?.metrics_json ?? null;
  };
  normalizeBenchmarkTimestamps: Method<"normalizeBenchmarkTimestamps"> = async (
    project,
    timestamp
  ) => {
    this.db
      .prepare("UPDATE episodes SET created_at = ? WHERE project = ?")
      .run(timestamp, project);
    this.db
      .prepare(
        `UPDATE semantic_memories
         SET created_at = ?, updated_at = ?, last_confirmed_at = ?
         WHERE project = ?`
      )
      .run(timestamp, timestamp, timestamp, project);
    this.db
      .prepare("UPDATE claim_versions SET recorded_at = ? WHERE project = ?")
      .run(timestamp, project);
    this.db
      .prepare(
        `UPDATE memory_evidence SET created_at = ?, ingested_at = ?
         WHERE claim_version_id IN (
           SELECT id FROM claim_versions WHERE project = ?
         )`
      )
      .run(timestamp, timestamp, project);
  };
}
