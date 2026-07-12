import type Database from "better-sqlite3";

export function readStoredVector(
  db: Database.Database,
  table: "memory_embeddings" | "episode_embeddings",
  column: "memory_id" | "episode_id",
  id: number,
  provider: string
): number[] | null {
  const row = db
    .prepare(`SELECT vector_json FROM ${table} WHERE ${column} = ? AND provider = ?`)
    .get(id, provider) as { vector_json: string } | undefined;
  return row ? (JSON.parse(row.vector_json) as number[]) : null;
}
