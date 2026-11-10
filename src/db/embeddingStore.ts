import type Database from "better-sqlite3";
import { contentHash, embedText } from "../memory/localEmbedding.js";
import { embedText as embedConfiguredText } from "../memory/embedding.js";

export type EmbeddingTarget = "memory" | "episode" | "claim_version";

const TARGET_TABLES: Record<EmbeddingTarget, { table: string; column: string }> = {
  memory: { table: "memory_embeddings", column: "memory_id" },
  episode: { table: "episode_embeddings", column: "episode_id" },
  claim_version: {
    table: "claim_version_embeddings",
    column: "claim_version_id",
  },
};

export function upsertLocalEmbedding(
  db: Database.Database,
  target: EmbeddingTarget,
  id: number,
  content: string
): void {
  writeEmbedding(db, target, id, "local-hash", embedText(content), content);
}

/**
 * Replaces a row's local-hash vector with the configured provider's: retrieval reads
 * vectors by the query's provider, so a row without one is invisible to the vector
 * channel. A provider that is down leaves the local vector; a backfill repairs it.
 */
export async function upsertConfiguredEmbedding(
  db: Database.Database,
  target: EmbeddingTarget,
  id: number,
  content: string
): Promise<void> {
  const provider = process.env.MEMORANTADO_EMBEDDING_PROVIDER?.trim() || "local-hash";
  if (provider === "local-hash") return;
  let embedding;
  try {
    embedding = await embedConfiguredText(content);
  } catch {
    return;
  }
  writeEmbedding(db, target, id, embedding.provider, embedding.vector, content);
}

function writeEmbedding(
  db: Database.Database,
  target: EmbeddingTarget,
  id: number,
  provider: string,
  vector: number[],
  content: string
): void {
  const { table, column } = TARGET_TABLES[target];
  db.prepare(
    `INSERT INTO ${table} (${column}, provider, dimension, vector_json, content_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(${column}) DO UPDATE SET
       provider = excluded.provider,
       dimension = excluded.dimension,
       vector_json = excluded.vector_json,
       content_hash = excluded.content_hash,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(id, provider, vector.length, JSON.stringify(vector), contentHash(content));
}
