import type Database from "better-sqlite3";
import { contentHash, embedText, embeddingDimension } from "../memory/localEmbedding.js";

const EXCHANGE_FORMAT = "memorantado-jsonl";
const EXCHANGE_VERSION = 1;

type ExchangeRecord = {
  format: typeof EXCHANGE_FORMAT;
  version: typeof EXCHANGE_VERSION;
  project: string;
  type: string;
  data: Record<string, unknown>;
};

const TABLES = [
  "episodes",
  "semantic_memories",
  "memory_sources",
  "memory_conflicts",
  "claim_versions",
  "memory_evidence",
  "conflict_resolution_events",
] as const;

export function exportProjectJsonl(db: Database.Database, project: string): string {
  const records: ExchangeRecord[] = [];
  for (const type of TABLES) {
    for (const data of readProjectRows(db, type, project)) {
      records.push({
        format: EXCHANGE_FORMAT,
        version: EXCHANGE_VERSION,
        project,
        type,
        data,
      });
    }
  }
  return (
    records.map((record) => JSON.stringify(record)).join("\n") +
    (records.length ? "\n" : "")
  );
}

export function importProjectJsonl(
  db: Database.Database,
  jsonl: string,
  projectOverride?: string
): { project: string; imported: Record<string, number> } {
  const records = jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map(parseRecord);
  const projects = new Set(records.map((record) => projectOverride ?? record.project));
  if (projects.size !== 1)
    throw new Error("JSONL import must contain exactly one project");
  const project = projects.values().next().value as string;
  const imported: Record<string, number> = {};
  db.transaction(() => {
    const counts = projectCounts(db, project);
    if (Object.values(counts).some((count) => count > 0)) {
      throw new Error(`project already contains hybrid memory data: ${project}`);
    }
    for (const type of TABLES) {
      for (const record of records.filter((candidate) => candidate.type === type)) {
        insertRecord(db, type, project, record.data);
        imported[type] = (imported[type] ?? 0) + 1;
      }
    }
    rebuildEmbeddings(db, project);
  })();
  return { project, imported };
}

function parseRecord(line: string): ExchangeRecord {
  const value = JSON.parse(line) as Partial<ExchangeRecord>;
  if (value.format !== EXCHANGE_FORMAT || value.version !== EXCHANGE_VERSION) {
    throw new Error("unsupported Memorantado JSONL format");
  }
  if (
    typeof value.project !== "string" ||
    typeof value.type !== "string" ||
    !value.data
  ) {
    throw new Error("invalid Memorantado JSONL record");
  }
  if (!TABLES.includes(value.type as (typeof TABLES)[number])) {
    throw new Error(`unsupported Memorantado JSONL record type: ${value.type}`);
  }
  return value as ExchangeRecord;
}

function readProjectRows(
  db: Database.Database,
  type: (typeof TABLES)[number],
  project: string
): Array<Record<string, unknown>> {
  if (type === "memory_sources") {
    return db
      .prepare(
        `SELECT ms.* FROM memory_sources ms
         JOIN semantic_memories sm ON sm.id = ms.memory_id
         WHERE sm.project = ? ORDER BY ms.memory_id, ms.episode_id`
      )
      .all(project) as Array<Record<string, unknown>>;
  }
  if (type === "memory_evidence") {
    return db
      .prepare(
        `SELECT me.* FROM memory_evidence me
         JOIN claim_versions cv ON cv.id = me.claim_version_id
         WHERE cv.project = ? ORDER BY me.id`
      )
      .all(project) as Array<Record<string, unknown>>;
  }
  const order = type === "episodes" || type === "semantic_memories" ? "id" : "id";
  return db
    .prepare(`SELECT * FROM ${type} WHERE project = ? ORDER BY ${order}`)
    .all(project) as Array<Record<string, unknown>>;
}

function projectCounts(db: Database.Database, project: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of [
    "episodes",
    "semantic_memories",
    "memory_conflicts",
    "claim_versions",
  ] as const) {
    const row = db
      .prepare(`SELECT count(*) AS count FROM ${table} WHERE project = ?`)
      .get(project) as {
      count: number;
    };
    counts[table] = row.count;
  }
  return counts;
}

function insertRecord(
  db: Database.Database,
  type: (typeof TABLES)[number],
  project: string,
  data: Record<string, unknown>
): void {
  const row: Record<string, unknown> = { ...data };
  if ("project" in row) row.project = project;
  const columns = Object.keys(row);
  const values = columns.map((column) => row[column]);
  const placeholders = columns.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${type} (${columns.join(", ")}) VALUES (${placeholders})`).run(
    ...values
  );
}

function rebuildEmbeddings(db: Database.Database, project: string): void {
  const memories = db
    .prepare("SELECT id, content FROM semantic_memories WHERE project = ?")
    .all(project) as Array<{ id: number; content: string }>;
  const memoryInsert = db.prepare(
    `INSERT INTO memory_embeddings (memory_id, provider, dimension, vector_json, content_hash)
     VALUES (?, 'local-hash', ?, ?, ?)`
  );
  for (const memory of memories) {
    memoryInsert.run(
      memory.id,
      embeddingDimension(),
      JSON.stringify(embedText(memory.content)),
      contentHash(memory.content)
    );
  }
  const episodes = db
    .prepare("SELECT id, content FROM episodes WHERE project = ?")
    .all(project) as Array<{ id: number; content: string }>;
  const episodeInsert = db.prepare(
    `INSERT INTO episode_embeddings (episode_id, provider, dimension, vector_json, content_hash)
     VALUES (?, 'local-hash', ?, ?, ?)`
  );
  for (const episode of episodes) {
    episodeInsert.run(
      episode.id,
      embeddingDimension(),
      JSON.stringify(embedText(episode.content)),
      contentHash(episode.content)
    );
  }
  const versions = db
    .prepare("SELECT id, content FROM claim_versions WHERE project = ?")
    .all(project) as Array<{ id: number; content: string }>;
  const versionInsert = db.prepare(
    `INSERT INTO claim_version_embeddings (claim_version_id, provider, dimension, vector_json, content_hash)
     VALUES (?, 'local-hash', ?, ?, ?)`
  );
  for (const version of versions) {
    versionInsert.run(
      version.id,
      embeddingDimension(),
      JSON.stringify(embedText(version.content)),
      contentHash(version.content)
    );
  }
}
