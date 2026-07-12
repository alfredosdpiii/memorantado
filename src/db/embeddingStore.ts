import type Database from "better-sqlite3";
import { contentHash, embedText, embeddingDimension } from "../memory/localEmbedding.js";

export function upsertLocalEmbedding(
  db: Database.Database,
  target: "memory" | "episode",
  id: number,
  content: string
): void {
  const table = target === "memory" ? "memory_embeddings" : "episode_embeddings";
  const column = target === "memory" ? "memory_id" : "episode_id";
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
