import { withTransaction, type Pool, type Queryable } from "./client.js";
import { upsertLocalEmbeddingPg } from "./embeddingOps.js";

const EXPORT_TABLES = [
  "episodes",
  "semantic_memories",
  "memory_sources",
  "memory_conflicts",
  "claim_versions",
  "memory_evidence",
  "conflict_resolution_events",
] as const;
type ExportTable = (typeof EXPORT_TABLES)[number];

type ExchangeRecord = {
  format: string;
  version: number;
  project: string;
  type: string;
  data: Record<string, unknown>;
};

export async function exportProjectJsonlPg(pool: Pool, project: string): Promise<string> {
  const lines: string[] = [];
  for (const type of EXPORT_TABLES) {
    for (const data of await readProjectRows(pool, type, project)) {
      lines.push(
        JSON.stringify({ format: "memorantado-jsonl", version: 1, project, type, data })
      );
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export async function importProjectJsonlPg(
  pool: Pool,
  jsonl: string,
  projectOverride?: string
): Promise<{ project: string; imported: Record<string, number> }> {
  const records = jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map((line): ExchangeRecord => {
      const value = JSON.parse(line) as Partial<ExchangeRecord>;
      if (value.format !== "memorantado-jsonl" || value.version !== 1) {
        throw new Error("unsupported Memorantado JSONL format");
      }
      if (
        typeof value.project !== "string" ||
        typeof value.type !== "string" ||
        !value.data
      ) {
        throw new Error("invalid Memorantado JSONL record");
      }
      if (!EXPORT_TABLES.includes(value.type as ExportTable)) {
        throw new Error(`unsupported Memorantado JSONL record type: ${value.type}`);
      }
      return value as ExchangeRecord;
    });
  const projects = new Set(records.map((record) => projectOverride ?? record.project));
  if (projects.size !== 1) {
    throw new Error("JSONL import must contain exactly one project");
  }
  const project = projects.values().next().value as string;
  const imported: Record<string, number> = {};
  await withTransaction(pool, async (client) => {
    for (const table of [
      "episodes",
      "semantic_memories",
      "memory_conflicts",
      "claim_versions",
    ] as const) {
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*) AS count FROM ${table} WHERE project = $1`,
        [project]
      );
      if (rows[0].count > 0) {
        throw new Error(`project already contains hybrid memory data: ${project}`);
      }
    }
    for (const type of EXPORT_TABLES) {
      for (const record of records.filter((candidate) => candidate.type === type)) {
        const row: Record<string, unknown> = { ...record.data };
        // Generated columns on pg; derived on insert, never written.
        delete row.search_vector;
        delete row.search_length;
        if ("project" in row) row.project = project;
        const columns = Object.keys(row);
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
        await client.query(
          `INSERT INTO ${type} (${columns.join(", ")}) VALUES (${placeholders})`,
          columns.map((column) => row[column])
        );
        imported[type] = (imported[type] ?? 0) + 1;
      }
    }
    // Explicit ids were inserted; realign identity sequences so future
    // inserts continue after the imported ids (mirrors sqlite rowid reuse).
    for (const table of [
      "episodes",
      "semantic_memories",
      "memory_conflicts",
      "claim_versions",
      "memory_evidence",
      "conflict_resolution_events",
    ] as const) {
      await client.query(
        `SELECT setval(
           pg_get_serial_sequence('${table}', 'id'),
           COALESCE((SELECT MAX(id) FROM ${table}), 1),
           (SELECT count(*) > 0 FROM ${table})
         )`
      );
    }
    await rebuildEmbeddingsPg(client, project);
  });
  return { project, imported };
}

async function rebuildEmbeddingsPg(db: Queryable, project: string): Promise<void> {
  const memories = await db.query<{ id: number; content: string }>(
    `SELECT id, content FROM semantic_memories WHERE project = $1`,
    [project]
  );
  for (const memory of memories.rows) {
    await upsertLocalEmbeddingPg(db, "memory", memory.id, project, memory.content);
  }
  const episodes = await db.query<{ id: number; content: string }>(
    `SELECT id, content FROM episodes WHERE project = $1`,
    [project]
  );
  for (const episode of episodes.rows) {
    await upsertLocalEmbeddingPg(db, "episode", episode.id, project, episode.content);
  }
  const versions = await db.query<{ id: number; content: string }>(
    `SELECT id, content FROM claim_versions WHERE project = $1`,
    [project]
  );
  for (const version of versions.rows) {
    await upsertLocalEmbeddingPg(
      db,
      "claim_version",
      version.id,
      project,
      version.content
    );
  }
}

async function readProjectRows(
  pool: Pool,
  type: ExportTable,
  project: string
): Promise<Array<Record<string, unknown>>> {
  if (type === "memory_sources") {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT ms.* FROM memory_sources ms
       JOIN semantic_memories sm ON sm.id = ms.memory_id
       WHERE sm.project = $1 ORDER BY ms.memory_id, ms.episode_id`,
      [project]
    );
    return rows;
  }
  if (type === "memory_evidence") {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT me.* FROM memory_evidence me
       JOIN claim_versions cv ON cv.id = me.claim_version_id
       WHERE cv.project = $1 ORDER BY me.id`,
      [project]
    );
    return rows;
  }
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM ${type} WHERE project = $1 ORDER BY id`,
    [project]
  );
  // Drop pg-only generated columns so the JSONL matches the sqlite export
  // shape exactly.
  return rows.map((row) => {
    const rest = { ...row };
    delete rest.search_vector;
    delete rest.search_length;
    return rest;
  });
}
