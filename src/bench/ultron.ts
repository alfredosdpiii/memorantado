import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStoreKind, type MemoryStore } from "../db/store.js";
import { runUltronRecallBenchmark } from "./ultronRecall.js";

/**
 * `npm run bench:ultron`: the Ultron-style scoped recall benchmark on a
 * throwaway store of the configured backend (never the real database).
 */
async function scratchStore(): Promise<{ store: MemoryStore; cleanup(): Promise<void> }> {
  if (resolveStoreKind() === "pg") {
    const databaseUrl = process.env.MEMORANTADO_DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error("MEMORANTADO_DATABASE_URL is required for pg");
    const { createScratchPgStore } = await import("../db/pg/admin.js");
    return createScratchPgStore(databaseUrl);
  }
  const { SqliteStore } = await import("../db/sqliteStore.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorantado-ultron-bench-"));
  const store = SqliteStore.create(path.join(dir, "bench.sqlite"));
  return {
    store,
    async cleanup() {
      await store.close();
      fs.rmSync(dir, { force: true, recursive: true });
    },
  };
}

const scratch = await scratchStore();
try {
  console.log(JSON.stringify(await runUltronRecallBenchmark(scratch.store), null, 2));
} finally {
  await scratch.cleanup();
}
