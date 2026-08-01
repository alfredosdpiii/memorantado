import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPgStore } from "./pgStore.js";
import type { MemoryStore } from "../store.js";

const MAINTENANCE_DATABASE = "postgres";

function adminUrlFor(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${MAINTENANCE_DATABASE}`;
  return url.toString();
}

export function databaseUrlForName(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`unsafe database name: ${name}`);
  }
  return `"${name}"`;
}

export async function createPgDatabase(databaseUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrlFor(databaseUrl) });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdent(name)}`);
  } finally {
    await client.end();
  }
}

export async function dropPgDatabase(databaseUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrlFor(databaseUrl) });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

/**
 * Provisions a throwaway database on the same server (used by tests and by
 * the deterministic benchmark fixture), initializes the pg schema, and drops
 * the database on cleanup. A provided name is recreated from scratch; an
 * omitted name gets a random suffix.
 */
export async function createScratchPgStore(
  databaseUrl: string,
  name?: string
): Promise<{ store: MemoryStore; cleanup: () => Promise<void> }> {
  const dbName = name ?? `memorantado_scratch_${randomBytes(8).toString("hex")}`;
  if (name) await dropPgDatabase(databaseUrl, dbName);
  await createPgDatabase(databaseUrl, dbName);
  try {
    const store = await createPgStore(databaseUrlForName(databaseUrl, dbName));
    return {
      store,
      async cleanup() {
        await store.close();
        await dropPgDatabase(databaseUrl, dbName);
      },
    };
  } catch (error) {
    await dropPgDatabase(databaseUrl, dbName).catch(() => {});
    throw error;
  }
}
