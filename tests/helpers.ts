import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";

export type TestDb = {
  cleanup(): void;
  db: Database.Database;
};

export function createTestDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorantado-test-"));
  const db = openDb(path.join(dir, "test.sqlite"));
  migrate(db);

  return {
    cleanup() {
      db.close();
      fs.rmSync(dir, { force: true, recursive: true });
    },
    db,
  };
}

export const HOST_HEADER = { host: "127.0.0.1:3789" };
