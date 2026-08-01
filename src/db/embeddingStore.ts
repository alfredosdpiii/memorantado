import type Database from "better-sqlite3";
import { contentHash, embedText, embeddingDimension } from "../memory/localEmbedding.js";

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
  const { table, column } = TARGET_TABLES[target];
  const vector = embedText(content);
  db.prepare(
    `INSERT INTO ${table} (${column}, provider, dimension, vector_json, content_hash)
     VALUES (?, 'local-hash', ?, ?, ?)
     ON CONFLICT(${column}) DO UPDATE SET
       provider = excluded.provider,
       dimension = excluded.dimension,
       vector_json = excluded.vector_json,
       content_hash = excluded.content_hash,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(id, embeddingDimension(), JSON.stringify(vector), contentHash(content));
}
