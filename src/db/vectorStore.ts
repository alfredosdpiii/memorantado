import type Database from "better-sqlite3";

export type EmbeddingTable =
  | "memory_embeddings"
  | "episode_embeddings"
  | "claim_version_embeddings";

export type EmbeddingIdColumn = "memory_id" | "episode_id" | "claim_version_id";

export function readStoredVector(
  db: Database.Database,
  table: EmbeddingTable,
  column: EmbeddingIdColumn,
  id: number,
  provider: string
): number[] | null {
  const row = db
    .prepare(`SELECT vector_json FROM ${table} WHERE ${column} = ? AND provider = ?`)
    .get(id, provider) as { vector_json: string } | undefined;
  return row ? (JSON.parse(row.vector_json) as number[]) : null;
}
