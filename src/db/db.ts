import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export function resolveDbPath(): string {
  if (process.env.MEMORANTADO_DB) return process.env.MEMORANTADO_DB;

  const dir = path.join(os.homedir(), ".memorantado");
  const file = path.join(dir, "memorantado.sqlite");

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  return file;
}

export function openDb(dbPath?: string): Database.Database {
  const finalPath = dbPath ?? resolveDbPath();
  const db = new Database(finalPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  try {
    fs.chmodSync(finalPath, 0o600);
  } catch {
    // ignore if chmod fails (e.g. Windows)
  }

  return db;
}

export type { Database };
