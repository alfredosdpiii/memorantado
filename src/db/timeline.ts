import type Database from "better-sqlite3";

export type MemoryItem = {
  id: number;
  project: string;
  kind: string;
  title: string | null;
  content: string;
  tags: string[];
  source: string | null;
  createdAt: string;
};

export function appendMemoryItem(
  db: Database.Database,
  project: string,
  item: {
    kind: string;
    title?: string;
    content: string;
    tags?: string[];
    source?: string;
  }
): MemoryItem {
  const tagsJson = item.tags?.length ? JSON.stringify(item.tags) : null;

  const row = db.prepare(`
    INSERT INTO memory_items (project, kind, title, content, tags_json, source)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id, project, kind, title, content, tags_json, source, created_at
  `).get(
    project,
    item.kind,
    item.title ?? null,
    item.content,
    tagsJson,
    item.source ?? null
  ) as {
    id: number;
    project: string;
    kind: string;
    title: string | null;
    content: string;
    tags_json: string | null;
    source: string | null;
    created_at: string;
  };

  return {
    id: row.id,
    project: row.project,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    source: row.source,
    createdAt: row.created_at,
  };
}

export function getMemoryItem(
  db: Database.Database,
  project: string,
  id: number
): MemoryItem | null {
  const row = db.prepare(`
    SELECT id, project, kind, title, content, tags_json, source, created_at
    FROM memory_items
    WHERE project = ? AND id = ?
  `).get(project, id) as {
    id: number;
    project: string;
    kind: string;
    title: string | null;
    content: string;
    tags_json: string | null;
    source: string | null;
    created_at: string;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    project: row.project,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    source: row.source,
    createdAt: row.created_at,
  };
}

export function deleteMemoryItem(
  db: Database.Database,
  project: string,
  id: number
): boolean {
  const info = db.prepare(`
    DELETE FROM memory_items WHERE project = ? AND id = ?
  `).run(project, id);

  return info.changes > 0;
}

export function searchMemoryItems(
  db: Database.Database,
  project: string,
  query: string,
  opts: { kind?: string; limit?: number; offset?: number } = {}
): MemoryItem[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const ftsQuery = query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(" OR ");

  if (!ftsQuery) {
    return listMemoryItems(db, project, opts);
  }

  let sql = `
    SELECT mi.id, mi.project, mi.kind, mi.title, mi.content, mi.tags_json, mi.source, mi.created_at
    FROM memory_items_fts f
    JOIN memory_items mi ON mi.id = f.rowid
    WHERE f.project = ? AND memory_items_fts MATCH ?
  `;
  const params: (string | number)[] = [project, ftsQuery];

  if (opts.kind) {
    sql += ` AND mi.kind = ?`;
    params.push(opts.kind);
  }

  sql += ` ORDER BY mi.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    project: string;
    kind: string;
    title: string | null;
    content: string;
    tags_json: string | null;
    source: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    project: row.project,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    source: row.source,
    createdAt: row.created_at,
  }));
}

export function listMemoryItems(
  db: Database.Database,
  project: string,
  opts: { kind?: string; limit?: number; offset?: number } = {}
): MemoryItem[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  let sql = `
    SELECT id, project, kind, title, content, tags_json, source, created_at
    FROM memory_items
    WHERE project = ?
  `;
  const params: (string | number)[] = [project];

  if (opts.kind) {
    sql += ` AND kind = ?`;
    params.push(opts.kind);
  }

  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    project: string;
    kind: string;
    title: string | null;
    content: string;
    tags_json: string | null;
    source: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    project: row.project,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    source: row.source,
    createdAt: row.created_at,
  }));
}

export function getProjects(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT project FROM entities
    UNION
    SELECT project FROM memory_items
    ORDER BY project
  `).all() as Array<{ project: string }>;

  return rows.map((r) => r.project);
}
