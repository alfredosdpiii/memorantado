import type { MemoryStore } from "../store.js";

// Placeholder; replaced by the full Postgres + pgvector implementation.
export async function createScratchPgStore(
  databaseUrl: string,
  name?: string
): Promise<{ store: MemoryStore; cleanup: () => Promise<void> }> {
  void databaseUrl;
  void name;
  throw new Error("pg backend not implemented yet");
}
