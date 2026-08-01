import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStoreKind, type MemoryStore } from "../src/db/store.js";
import { SqliteStore } from "../src/db/sqliteStore.js";

export const STORE_KIND = resolveStoreKind();

export type TestStore = {
  cleanup(): Promise<void>;
  store: MemoryStore;
};

/**
 * Fresh isolated store per test. SQLite (default) uses a temp file like
 * before; Postgres (MEMORANTADO_STORE=pg) provisions a throwaway database on
 * the server pointed at by MEMORANTADO_DATABASE_URL and drops it on cleanup.
 */
export async function createTestStore(): Promise<TestStore> {
  if (STORE_KIND === "pg") {
    const databaseUrl = process.env.MEMORANTADO_DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("MEMORANTADO_DATABASE_URL is required when MEMORANTADO_STORE=pg");
    }
    const { createScratchPgStore } = await import("../src/db/pg/admin.js");
    const name = `memorantado_test_${randomBytes(8).toString("hex")}`;
    return createScratchPgStore(databaseUrl, name);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorantado-test-"));
  const store = SqliteStore.create(path.join(dir, "test.sqlite"));
  return {
    async cleanup() {
      await store.close();
      fs.rmSync(dir, { force: true, recursive: true });
    },
    store,
  };
}

export const HOST_HEADER = { host: "127.0.0.1:3789" };
