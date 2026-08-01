import type { MemoryStore } from "../store.js";

// Placeholder; replaced by the full Postgres + pgvector implementation.
export async function createPgStore(databaseUrl: string): Promise<MemoryStore> {
  void databaseUrl;
  throw new Error("pg backend not implemented yet");
}
