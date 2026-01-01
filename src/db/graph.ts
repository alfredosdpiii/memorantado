import type Database from "better-sqlite3";

export type GraphEntity = {
  name: string;
  entityType: string;
  observations: string[];
};

export type GraphRelation = {
  from: string;
  to: string;
  relationType: string;
};

export type Graph = {
  entities: GraphEntity[];
  relations: GraphRelation[];
};

const MAX_SEED_ENTITIES = 200;
const MAX_RELATIONS = 2000;
const MAX_ENTITIES = 500;

export function createEntities(
  db: Database.Database,
  project: string,
  entities: Array<{ name: string; entityType: string; observations?: string[] }>
): GraphEntity[] {
  const insertEntity = db.prepare(`
    INSERT INTO entities (project, name, entity_type)
    VALUES (?, ?, ?)
    ON CONFLICT(project, name) DO UPDATE SET
      entity_type = excluded.entity_type,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    RETURNING id, name, entity_type
  `);

  const insertObs = db.prepare(`
    INSERT OR IGNORE INTO observations (entity_id, content)
    VALUES (?, ?)
  `);

  const results: GraphEntity[] = [];

  db.transaction(() => {
    for (const e of entities) {
      const row = insertEntity.get(project, e.name, e.entityType) as {
        id: number;
        name: string;
        entity_type: string;
      };

      const addedObs: string[] = [];
      for (const obs of e.observations ?? []) {
        const info = insertObs.run(row.id, obs);
        if (info.changes > 0) addedObs.push(obs);
      }

      results.push({
        name: row.name,
        entityType: row.entity_type,
        observations: addedObs,
      });
    }
  })();

  return results;
}

export function createRelations(
  db: Database.Database,
  project: string,
  relations: Array<{ from: string; to: string; relationType: string }>
): GraphRelation[] {
  const findEntity = db.prepare(`
    SELECT id FROM entities WHERE project = ? AND name = ?
  `);

  const insertRel = db.prepare(`
    INSERT OR IGNORE INTO relations (project, from_entity_id, to_entity_id, relation_type)
    VALUES (?, ?, ?, ?)
  `);

  const results: GraphRelation[] = [];

  db.transaction(() => {
    for (const r of relations) {
      const fromRow = findEntity.get(project, r.from) as { id: number } | undefined;
      const toRow = findEntity.get(project, r.to) as { id: number } | undefined;

      if (!fromRow || !toRow) continue;

      const info = insertRel.run(project, fromRow.id, toRow.id, r.relationType);
      if (info.changes > 0) {
        results.push({ from: r.from, to: r.to, relationType: r.relationType });
      }
    }
  })();

  return results;
}

export function addObservations(
  db: Database.Database,
  project: string,
  observations: Array<{ entityName: string; contents: string[] }>
): Array<{ entityName: string; addedObservations: string[] }> {
  const findEntity = db.prepare(`
    SELECT id FROM entities WHERE project = ? AND name = ?
  `);

  const insertObs = db.prepare(`
    INSERT OR IGNORE INTO observations (entity_id, content)
    VALUES (?, ?)
  `);

  const results: Array<{ entityName: string; addedObservations: string[] }> = [];

  db.transaction(() => {
    for (const o of observations) {
      const row = findEntity.get(project, o.entityName) as { id: number } | undefined;
      if (!row) continue;

      const added: string[] = [];
      for (const content of o.contents) {
        const info = insertObs.run(row.id, content);
        if (info.changes > 0) added.push(content);
      }

      results.push({ entityName: o.entityName, addedObservations: added });
    }
  })();

  return results;
}

export function deleteEntities(
  db: Database.Database,
  project: string,
  entityNames: string[]
): void {
  const del = db.prepare(`
    DELETE FROM entities WHERE project = ? AND name = ?
  `);

  db.transaction(() => {
    for (const name of entityNames) {
      del.run(project, name);
    }
  })();
}

export function deleteObservations(
  db: Database.Database,
  project: string,
  deletions: Array<{ entityName: string; observations: string[] }>
): void {
  const findEntity = db.prepare(`
    SELECT id FROM entities WHERE project = ? AND name = ?
  `);

  const delObs = db.prepare(`
    DELETE FROM observations WHERE entity_id = ? AND content = ?
  `);

  db.transaction(() => {
    for (const d of deletions) {
      const row = findEntity.get(project, d.entityName) as { id: number } | undefined;
      if (!row) continue;

      for (const obs of d.observations) {
        delObs.run(row.id, obs);
      }
    }
  })();
}

export function deleteRelations(
  db: Database.Database,
  project: string,
  relations: Array<{ from: string; to: string; relationType: string }>
): void {
  const findEntity = db.prepare(`
    SELECT id FROM entities WHERE project = ? AND name = ?
  `);

  const delRel = db.prepare(`
    DELETE FROM relations 
    WHERE project = ? AND from_entity_id = ? AND to_entity_id = ? AND relation_type = ?
  `);

  db.transaction(() => {
    for (const r of relations) {
      const fromRow = findEntity.get(project, r.from) as { id: number } | undefined;
      const toRow = findEntity.get(project, r.to) as { id: number } | undefined;
      if (!fromRow || !toRow) continue;

      delRel.run(project, fromRow.id, toRow.id, r.relationType);
    }
  })();
}

export function readGraph(db: Database.Database, project: string): Graph {
  const entities = db.prepare(`
    SELECT id, name, entity_type FROM entities WHERE project = ?
  `).all(project) as Array<{ id: number; name: string; entity_type: string }>;

  if (!entities.length) return { entities: [], relations: [] };

  const entityIds = entities.map((e) => e.id);
  const idToName = new Map(entities.map((e) => [e.id, e.name]));

  const placeholders = entityIds.map(() => "?").join(",");

  const obsRows = db.prepare(`
    SELECT entity_id, content FROM observations
    WHERE entity_id IN (${placeholders})
    ORDER BY id
  `).all(...entityIds) as Array<{ entity_id: number; content: string }>;

  const obsMap = new Map<number, string[]>();
  for (const o of obsRows) {
    const arr = obsMap.get(o.entity_id) ?? [];
    arr.push(o.content);
    obsMap.set(o.entity_id, arr);
  }

  const relRows = db.prepare(`
    SELECT from_entity_id, to_entity_id, relation_type FROM relations WHERE project = ?
  `).all(project) as Array<{
    from_entity_id: number;
    to_entity_id: number;
    relation_type: string;
  }>;

  return {
    entities: entities.map((e) => ({
      name: e.name,
      entityType: e.entity_type,
      observations: obsMap.get(e.id) ?? [],
    })),
    relations: relRows.map((r) => ({
      from: idToName.get(r.from_entity_id)!,
      to: idToName.get(r.to_entity_id)!,
      relationType: r.relation_type,
    })),
  };
}

function readExpandedGraphBySeedIds(
  db: Database.Database,
  project: string,
  seedIds: number[]
): Graph {
  if (!seedIds.length) return { entities: [], relations: [] };

  const seedPlaceholders = seedIds.map(() => "?").join(",");

  const relRows = db.prepare(`
    SELECT id, from_entity_id, to_entity_id, relation_type
    FROM relations
    WHERE project = ?
      AND (from_entity_id IN (${seedPlaceholders})
           OR to_entity_id IN (${seedPlaceholders}))
    LIMIT ${MAX_RELATIONS}
  `).all(project, ...seedIds, ...seedIds) as Array<{
    id: number;
    from_entity_id: number;
    to_entity_id: number;
    relation_type: string;
  }>;

  const allIdSet = new Set(seedIds);
  for (const r of relRows) {
    allIdSet.add(r.from_entity_id);
    allIdSet.add(r.to_entity_id);
  }
  const allIds = Array.from(allIdSet).slice(0, MAX_ENTITIES);

  const allPlaceholders = allIds.map(() => "?").join(",");

  const entRows = db.prepare(`
    SELECT id, name, entity_type
    FROM entities
    WHERE project = ? AND id IN (${allPlaceholders})
    LIMIT ${MAX_ENTITIES}
  `).all(project, ...allIds) as Array<{
    id: number;
    name: string;
    entity_type: string;
  }>;

  const idToName = new Map(entRows.map((e) => [e.id, e.name]));
  const entitiesById = new Map<number, GraphEntity>();
  for (const e of entRows) {
    entitiesById.set(e.id, { name: e.name, entityType: e.entity_type, observations: [] });
  }

  const obsRows = db.prepare(`
    SELECT entity_id, content
    FROM observations
    WHERE entity_id IN (${allPlaceholders})
    ORDER BY id
  `).all(...allIds) as Array<{ entity_id: number; content: string }>;

  for (const o of obsRows) {
    const ent = entitiesById.get(o.entity_id);
    if (ent) ent.observations.push(o.content);
  }

  const relations: GraphRelation[] = [];
  for (const r of relRows) {
    const from = idToName.get(r.from_entity_id);
    const to = idToName.get(r.to_entity_id);
    if (from && to) relations.push({ from, to, relationType: r.relation_type });
  }

  return { entities: Array.from(entitiesById.values()), relations };
}

export function searchNodes(
  db: Database.Database,
  project: string,
  query: string
): Graph {
  const ftsQuery = query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(" OR ");

  if (!ftsQuery) return { entities: [], relations: [] };

  const entityHits = db.prepare(`
    SELECT e.id
    FROM entities_fts f
    JOIN entities e ON e.id = f.rowid
    WHERE f.project = ? AND entities_fts MATCH ?
    LIMIT ${MAX_SEED_ENTITIES}
  `).all(project, ftsQuery) as Array<{ id: number }>;

  const obsHits = db.prepare(`
    SELECT DISTINCT e.id
    FROM observations_fts f
    JOIN observations o ON o.id = f.rowid
    JOIN entities e ON e.id = o.entity_id
    WHERE f.project = ? AND observations_fts MATCH ?
    LIMIT ${MAX_SEED_ENTITIES}
  `).all(project, ftsQuery) as Array<{ id: number }>;

  const seedSet = new Set<number>();
  for (const r of entityHits) seedSet.add(r.id);
  for (const r of obsHits) seedSet.add(r.id);

  const seedIds = Array.from(seedSet).slice(0, MAX_SEED_ENTITIES);

  return readExpandedGraphBySeedIds(db, project, seedIds);
}

export function openNodes(
  db: Database.Database,
  project: string,
  names: string[]
): Graph {
  if (!names.length) return { entities: [], relations: [] };

  const placeholders = names.map(() => "?").join(",");

  const rows = db.prepare(`
    SELECT id FROM entities
    WHERE project = ? AND name IN (${placeholders})
  `).all(project, ...names) as Array<{ id: number }>;

  const seedIds = rows.map((r) => r.id);

  return readExpandedGraphBySeedIds(db, project, seedIds);
}

export function getEntityByName(
  db: Database.Database,
  project: string,
  name: string
): (GraphEntity & { id: number; relations: GraphRelation[] }) | null {
  const row = db.prepare(`
    SELECT id, name, entity_type FROM entities WHERE project = ? AND name = ?
  `).get(project, name) as { id: number; name: string; entity_type: string } | undefined;

  if (!row) return null;

  const obsRows = db.prepare(`
    SELECT content FROM observations WHERE entity_id = ? ORDER BY id
  `).all(row.id) as Array<{ content: string }>;

  const relRows = db.prepare(`
    SELECT 
      ef.name as from_name,
      et.name as to_name,
      r.relation_type
    FROM relations r
    JOIN entities ef ON ef.id = r.from_entity_id
    JOIN entities et ON et.id = r.to_entity_id
    WHERE r.project = ? AND (r.from_entity_id = ? OR r.to_entity_id = ?)
  `).all(project, row.id, row.id) as Array<{
    from_name: string;
    to_name: string;
    relation_type: string;
  }>;

  return {
    id: row.id,
    name: row.name,
    entityType: row.entity_type,
    observations: obsRows.map((o) => o.content),
    relations: relRows.map((r) => ({
      from: r.from_name,
      to: r.to_name,
      relationType: r.relation_type,
    })),
  };
}

export function deleteObservationById(db: Database.Database, id: number): void {
  db.prepare(`DELETE FROM observations WHERE id = ?`).run(id);
}

export function deleteRelationById(db: Database.Database, id: number): void {
  db.prepare(`DELETE FROM relations WHERE id = ?`).run(id);
}

export function createRelationDirect(
  db: Database.Database,
  project: string,
  from: string,
  to: string,
  relationType: string
): { id: number } | null {
  const findEntity = db.prepare(`SELECT id FROM entities WHERE project = ? AND name = ?`);

  const fromRow = findEntity.get(project, from) as { id: number } | undefined;
  const toRow = findEntity.get(project, to) as { id: number } | undefined;

  if (!fromRow || !toRow) return null;

  const result = db.prepare(`
    INSERT INTO relations (project, from_entity_id, to_entity_id, relation_type)
    VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING
    RETURNING id
  `).get(project, fromRow.id, toRow.id, relationType) as { id: number } | undefined;

  return result ?? null;
}
