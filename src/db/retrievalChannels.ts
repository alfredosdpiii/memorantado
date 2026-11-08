import type Database from "better-sqlite3";
import { EPISODE_TAGS, MEMORY_TAGS, sqliteBinder, tagPredicate } from "../memory/tags.js";
import type { Episode, SemanticMemory, TagFilter } from "../memory/types.js";
import {
  episodeColumns,
  ftsQuery,
  mapEpisode,
  mapMemory,
  MEMORY_WITH_LIFECYCLE_SELECT,
  type EpisodeRow,
  type SemanticMemoryRow,
} from "./hybridRows.js";

/*
 * Candidate channels of sqlite retrieval (the pg mirror is pg/channels.ts):
 * the scanned active memories and recent episodes, and their bm25 matches,
 * each restricted to a tag scope when one is given.
 */

const EPISODE_COLUMNS = episodeColumns("sqlite", "e");

export function listActiveMemories(
  db: Database.Database,
  project: string,
  limit: number,
  tags?: TagFilter
): SemanticMemory[] {
  const params: Array<string | number> = [project];
  const scoped = tags
    ? `AND ${tagPredicate(MEMORY_TAGS, "sm.id", tags, sqliteBinder(params))}`
    : "";
  params.push(limit);
  return (
    db
      .prepare(
        `${MEMORY_WITH_LIFECYCLE_SELECT}
         WHERE sm.project = ? AND sm.status = 'active'
           AND COALESCE(ml.status, 'active') = 'active' ${scoped}
         ORDER BY sm.importance DESC, sm.updated_at DESC
         LIMIT ?`
      )
      .all(...params) as SemanticMemoryRow[]
  ).map(mapMemory);
}

export function listRecentEpisodes(
  db: Database.Database,
  project: string,
  limit: number,
  tags?: TagFilter
): Episode[] {
  const params: Array<string | number> = [project];
  const scoped = tags
    ? `AND ${tagPredicate(EPISODE_TAGS, "e.id", tags, sqliteBinder(params))}`
    : "";
  params.push(limit);
  return (
    db
      .prepare(
        `SELECT ${EPISODE_COLUMNS} FROM episodes e
         WHERE e.project = ? ${scoped}
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT ?`
      )
      .all(...params) as EpisodeRow[]
  ).map(mapEpisode);
}

export function searchMemoryFts(
  db: Database.Database,
  project: string,
  query: string,
  limit: number,
  tags?: TagFilter
): Array<{ id: number; score: number }> {
  const match = ftsQuery(query);
  if (!match) return [];
  const params: Array<string | number> = [project];
  const scoped = tags
    ? `AND ${tagPredicate(MEMORY_TAGS, "sm.id", tags, sqliteBinder(params))}`
    : "";
  params.push(match, limit);
  return db
    .prepare(
      `
      SELECT sm.id, bm25(semantic_memories_fts) AS score
      FROM semantic_memories_fts
      JOIN semantic_memories sm ON sm.id = semantic_memories_fts.rowid
      LEFT JOIN memory_lifecycle ml ON ml.memory_id = sm.id
      WHERE semantic_memories_fts.project = ? AND sm.status = 'active'
        AND COALESCE(ml.status, 'active') = 'active' ${scoped}
        AND semantic_memories_fts MATCH ?
      ORDER BY score ASC, sm.id ASC
      LIMIT ?
    `
    )
    .all(...params) as Array<{ id: number; score: number }>;
}

export function searchEpisodeFts(
  db: Database.Database,
  project: string,
  query: string,
  limit: number,
  tags?: TagFilter
): Array<{ id: number; score: number }> {
  const match = ftsQuery(query);
  if (!match) return [];
  const params: Array<string | number> = [project];
  const scoped = tags
    ? `AND ${tagPredicate(EPISODE_TAGS, "e.id", tags, sqliteBinder(params))}`
    : "";
  params.push(match, limit);
  return db
    .prepare(
      `SELECT e.id, bm25(episodes_fts) AS score
       FROM episodes_fts
       JOIN episodes e ON e.id = episodes_fts.rowid
       WHERE episodes_fts.project = ? ${scoped} AND episodes_fts MATCH ?
       ORDER BY score ASC, e.id ASC LIMIT ?`
    )
    .all(...params) as Array<{ id: number; score: number }>;
}
