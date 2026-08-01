import type { Graph, GraphEntity, GraphRelation } from "../graph.js";
import type { Queryable } from "./client.js";
import { toPrefixTsquery } from "./channels.js";

const MAX_SEED_ENTITIES = 200;
const MAX_RELATIONS = 2000;
const MAX_ENTITIES = 500;

/**
 * pg port of graph.searchNodes: the FTS5 entities/observations searches
 * become tsvector matches (entities keep a generated column; observations
 * are computed inline like sqlite's ad-hoc ftsMatch on name || ' ' || content).
 */
export async function searchNodesPg(
  db: Queryable,
  project: string,
  query: string
): Promise<Graph> {
  const words = query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return { entities: [], relations: [] };
  const tsquery = toPrefixTsquery(words.map((word) => word.toLowerCase()));
  const entityHits = await db.query<{ id: number }>(
    `SELECT e.id
     FROM entities e
     WHERE e.project = $1 AND e.search_vector @@ to_tsquery('english', $2)
     ORDER BY e.id
     LIMIT ${MAX_SEED_ENTITIES}`,
    [project, tsquery]
  );
  const obsHits = await db.query<{ id: number }>(
    `SELECT DISTINCT e.id
     FROM observations o
     JOIN entities e ON e.id = o.entity_id
     WHERE e.project = $1
       AND to_tsvector('english', e.name || ' ' || o.content) @@ to_tsquery('english', $2)
     ORDER BY e.id
     LIMIT ${MAX_SEED_ENTITIES}`,
    [project, tsquery]
  );
  const seedSet = new Set<number>();
  for (const row of entityHits.rows) seedSet.add(row.id);
  for (const row of obsHits.rows) seedSet.add(row.id);
  const seedIds = [...seedSet].slice(0, MAX_SEED_ENTITIES);
  return readExpandedGraphBySeedIds(db, project, seedIds);
}

export async function readExpandedGraphBySeedIds(
  db: Queryable,
  project: string,
  seedIds: number[]
): Promise<Graph> {
  if (!seedIds.length) return { entities: [], relations: [] };
  const relRows = await db.query<{
    id: number;
    from_entity_id: number;
    to_entity_id: number;
    relation_type: string;
  }>(
    `SELECT id, from_entity_id, to_entity_id, relation_type
     FROM relations
     WHERE project = $1
       AND (from_entity_id = ANY($2) OR to_entity_id = ANY($2))
     ORDER BY id
     LIMIT ${MAX_RELATIONS}`,
    [project, seedIds]
  );
  const allIdSet = new Set(seedIds);
  for (const row of relRows.rows) {
    allIdSet.add(row.from_entity_id);
    allIdSet.add(row.to_entity_id);
  }
  const allIds = [...allIdSet].slice(0, MAX_ENTITIES);
  const entRows = await db.query<{ id: number; name: string; entity_type: string }>(
    `SELECT id, name, entity_type
     FROM entities
     WHERE project = $1 AND id = ANY($2)
     ORDER BY id
     LIMIT ${MAX_ENTITIES}`,
    [project, allIds]
  );
  const idToName = new Map(entRows.rows.map((row) => [row.id, row.name]));
  const entitiesById = new Map<number, GraphEntity>();
  for (const row of entRows.rows) {
    entitiesById.set(row.id, {
      name: row.name,
      entityType: row.entity_type,
      observations: [],
    });
  }
  const obsRows = await db.query<{ entity_id: number; content: string }>(
    `SELECT entity_id, content
     FROM observations
     WHERE entity_id = ANY($1)
     ORDER BY id`,
    [allIds]
  );
  for (const row of obsRows.rows) {
    entitiesById.get(row.entity_id)?.observations.push(row.content);
  }
  const relations: GraphRelation[] = [];
  for (const row of relRows.rows) {
    const from = idToName.get(row.from_entity_id);
    const to = idToName.get(row.to_entity_id);
    if (from && to) relations.push({ from, to, relationType: row.relation_type });
  }
  return { entities: [...entitiesById.values()], relations };
}
