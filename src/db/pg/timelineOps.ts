import type { MemoryItem } from "../timeline.js";
import { toPrefixTsquery } from "./channels.js";
import type { Pool } from "./client.js";

type MemoryItemRow = {
  id: number;
  project: string;
  kind: string;
  title: string | null;
  content: string;
  tags_json: string | null;
  source: string | null;
  created_at: string;
};

function mapMemoryItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    project: row.project,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tags: row.tags_json ? (JSON.parse(row.tags_json) as string[]) : [],
    source: row.source,
    createdAt: row.created_at,
  };
}

const MEMORY_ITEM_COLUMNS =
  "id, project, kind, title, content, tags_json, source, created_at";

export async function appendMemoryItemPg(
  pool: Pool,
  project: string,
  item: {
    kind: string;
    title?: string | null;
    content: string;
    tags?: string[];
    source?: string | null;
  }
): Promise<MemoryItem> {
  const tagsJson = item.tags?.length ? JSON.stringify(item.tags) : null;
  const { rows } = await pool.query<MemoryItemRow>(
    `INSERT INTO memory_items (project, kind, title, content, tags_json, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${MEMORY_ITEM_COLUMNS}`,
    [project, item.kind, item.title ?? null, item.content, tagsJson, item.source ?? null]
  );
  return mapMemoryItem(rows[0]);
}

export async function getMemoryItemPg(
  pool: Pool,
  project: string,
  id: number
): Promise<MemoryItem | null> {
  const { rows } = await pool.query<MemoryItemRow>(
    `SELECT ${MEMORY_ITEM_COLUMNS} FROM memory_items WHERE project = $1 AND id = $2`,
    [project, id]
  );
  return rows[0] ? mapMemoryItem(rows[0]) : null;
}

export async function deleteMemoryItemPg(
  pool: Pool,
  project: string,
  id: number
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM memory_items WHERE project = $1 AND id = $2`,
    [project, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function searchMemoryItemsPg(
  pool: Pool,
  project: string,
  query: string,
  opts: { kind?: string; limit?: number; offset?: number } = {}
): Promise<MemoryItem[]> {
  const words = query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) {
    return listMemoryItemsPg(pool, project, opts);
  }
  const tsquery = toPrefixTsquery(words.map((word) => word.toLowerCase()));
  return queryMemoryItems(pool, project, opts, [
    "f.search_vector @@ to_tsquery('english', $2)",
    tsquery,
  ]);
}

export async function listMemoryItemsPg(
  pool: Pool,
  project: string,
  opts: { kind?: string; limit?: number; offset?: number } = {}
): Promise<MemoryItem[]> {
  return queryMemoryItems(pool, project, opts);
}

async function queryMemoryItems(
  pool: Pool,
  project: string,
  opts: { kind?: string; limit?: number; offset?: number },
  extra?: [clause: string, value: string]
): Promise<MemoryItem[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const clauses = ["f.project = $1"];
  const params: Array<string | number> = [project];
  if (extra) {
    clauses.push(extra[0]);
    params.push(extra[1]);
  }
  if (opts.kind) {
    clauses.push(`f.kind = $${params.length + 1}`);
    params.push(opts.kind);
  }
  params.push(limit, offset);
  const { rows } = await pool.query<MemoryItemRow>(
    `SELECT ${MEMORY_ITEM_COLUMNS}
     FROM memory_items f
     WHERE ${clauses.join(" AND ")}
     ORDER BY f.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(mapMemoryItem);
}

export async function getProjectsPg(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ project: string }>(
    `SELECT project FROM entities
     UNION
     SELECT project FROM memory_items
     UNION
     SELECT project FROM episodes
     UNION
     SELECT project FROM semantic_memories
     ORDER BY project`
  );
  return rows.map((row) => row.project);
}
