import type { Graph, GraphEntity, GraphRelation } from "../graph.js";
import { withTransaction, type Pool, type Queryable } from "./client.js";
import { readExpandedGraphBySeedIds } from "./graphSearch.js";

export async function findEntityId(
  db: Queryable,
  project: string,
  name: string
): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM entities WHERE project = $1 AND name = $2`,
    [project, name]
  );
  return rows[0]?.id ?? null;
}

export async function createEntitiesPg(
  pool: Pool,
  project: string,
  entities: Array<{ name: string; entityType: string; observations?: string[] }>
): Promise<GraphEntity[]> {
  return withTransaction(pool, async (client) => {
    const results: GraphEntity[] = [];
    for (const entity of entities) {
      const { rows } = await client.query<{
        id: number;
        name: string;
        entity_type: string;
      }>(
        `INSERT INTO entities (project, name, entity_type)
         VALUES ($1, $2, $3)
         ON CONFLICT(project, name) DO UPDATE SET
           entity_type = EXCLUDED.entity_type,
           updated_at = now()
         RETURNING id, name, entity_type`,
        [project, entity.name, entity.entityType]
      );
      const row = rows[0];
      const addedObs: string[] = [];
      for (const observation of entity.observations ?? []) {
        const inserted = await client.query<{ id: number }>(
          `INSERT INTO observations (entity_id, content)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [row.id, observation]
        );
        if (inserted.rows.length > 0) addedObs.push(observation);
      }
      results.push({
        name: row.name,
        entityType: row.entity_type,
        observations: addedObs,
      });
    }
    return results;
  });
}

export async function createRelationsPg(
  pool: Pool,
  project: string,
  relations: GraphRelation[]
): Promise<GraphRelation[]> {
  return withTransaction(pool, async (client) => {
    const results: GraphRelation[] = [];
    for (const relation of relations) {
      const fromId = await findEntityId(client, project, relation.from);
      const toId = await findEntityId(client, project, relation.to);
      if (fromId === null || toId === null) continue;
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO relations (project, from_entity_id, to_entity_id, relation_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [project, fromId, toId, relation.relationType]
      );
      if (inserted.rows.length > 0) {
        results.push({
          from: relation.from,
          to: relation.to,
          relationType: relation.relationType,
        });
      }
    }
    return results;
  });
}

export async function addObservationsPg(
  pool: Pool,
  project: string,
  observations: Array<{ entityName: string; contents: string[] }>
): Promise<Array<{ entityName: string; addedObservations: string[] }>> {
  return withTransaction(pool, async (client) => {
    const results: Array<{ entityName: string; addedObservations: string[] }> = [];
    for (const entry of observations) {
      const entityId = await findEntityId(client, project, entry.entityName);
      if (entityId === null) continue;
      const added: string[] = [];
      for (const content of entry.contents) {
        const inserted = await client.query<{ id: number }>(
          `INSERT INTO observations (entity_id, content)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [entityId, content]
        );
        if (inserted.rows.length > 0) added.push(content);
      }
      results.push({ entityName: entry.entityName, addedObservations: added });
    }
    return results;
  });
}

export async function deleteEntitiesPg(
  pool: Pool,
  project: string,
  entityNames: string[]
): Promise<void> {
  await withTransaction(pool, async (client) => {
    for (const name of entityNames) {
      await client.query(`DELETE FROM entities WHERE project = $1 AND name = $2`, [
        project,
        name,
      ]);
    }
  });
}

export async function deleteObservationsPg(
  pool: Pool,
  project: string,
  deletions: Array<{ entityName: string; observations: string[] }>
): Promise<void> {
  await withTransaction(pool, async (client) => {
    for (const deletion of deletions) {
      const entityId = await findEntityId(client, project, deletion.entityName);
      if (entityId === null) continue;
      for (const content of deletion.observations) {
        await client.query(
          `DELETE FROM observations WHERE entity_id = $1 AND content = $2`,
          [entityId, content]
        );
      }
    }
  });
}

export async function deleteRelationsPg(
  pool: Pool,
  project: string,
  relations: GraphRelation[]
): Promise<void> {
  await withTransaction(pool, async (client) => {
    for (const relation of relations) {
      const fromId = await findEntityId(client, project, relation.from);
      const toId = await findEntityId(client, project, relation.to);
      if (fromId === null || toId === null) continue;
      await client.query(
        `DELETE FROM relations
         WHERE project = $1 AND from_entity_id = $2 AND to_entity_id = $3
           AND relation_type = $4`,
        [project, fromId, toId, relation.relationType]
      );
    }
  });
}

export async function readGraphPg(pool: Pool, project: string): Promise<Graph> {
  const entities = await pool.query<{ id: number; name: string; entity_type: string }>(
    `SELECT id, name, entity_type FROM entities WHERE project = $1 ORDER BY id`,
    [project]
  );
  if (!entities.rows.length) return { entities: [], relations: [] };
  const entityIds = entities.rows.map((row) => row.id);
  const idToName = new Map(entities.rows.map((row) => [row.id, row.name]));
  const obsRows = await pool.query<{ entity_id: number; content: string }>(
    `SELECT entity_id, content FROM observations
     WHERE entity_id = ANY($1) ORDER BY id`,
    [entityIds]
  );
  const obsMap = new Map<number, string[]>();
  for (const row of obsRows.rows) {
    const list = obsMap.get(row.entity_id) ?? [];
    list.push(row.content);
    obsMap.set(row.entity_id, list);
  }
  const relRows = await pool.query<{
    from_entity_id: number;
    to_entity_id: number;
    relation_type: string;
  }>(
    `SELECT from_entity_id, to_entity_id, relation_type
     FROM relations WHERE project = $1 ORDER BY id`,
    [project]
  );
  return {
    entities: entities.rows.map((row) => ({
      name: row.name,
      entityType: row.entity_type,
      observations: obsMap.get(row.id) ?? [],
    })),
    relations: relRows.rows.map((row) => ({
      from: idToName.get(row.from_entity_id)!,
      to: idToName.get(row.to_entity_id)!,
      relationType: row.relation_type,
    })),
  };
}

export async function openNodesPg(
  pool: Pool,
  project: string,
  names: string[]
): Promise<Graph> {
  if (!names.length) return { entities: [], relations: [] };
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM entities WHERE project = $1 AND name = ANY($2)`,
    [project, names]
  );
  return readExpandedGraphBySeedIds(
    pool,
    project,
    rows.map((row) => row.id)
  );
}

export async function getEntityByNamePg(
  pool: Pool,
  project: string,
  name: string
): Promise<{
  id: number;
  name: string;
  entityType: string;
  observations: string[];
  relations: GraphRelation[];
} | null> {
  const { rows } = await pool.query<{ id: number; name: string; entity_type: string }>(
    `SELECT id, name, entity_type FROM entities WHERE project = $1 AND name = $2`,
    [project, name]
  );
  const row = rows[0];
  if (!row) return null;
  const obsRows = await pool.query<{ content: string }>(
    `SELECT content FROM observations WHERE entity_id = $1 ORDER BY id`,
    [row.id]
  );
  const relRows = await pool.query<{
    from_name: string;
    to_name: string;
    relation_type: string;
  }>(
    `SELECT ef.name AS from_name, et.name AS to_name, r.relation_type
     FROM relations r
     JOIN entities ef ON ef.id = r.from_entity_id
     JOIN entities et ON et.id = r.to_entity_id
     WHERE r.project = $1 AND (r.from_entity_id = $2 OR r.to_entity_id = $2)`,
    [project, row.id]
  );
  return {
    id: row.id,
    name: row.name,
    entityType: row.entity_type,
    observations: obsRows.rows.map((obs) => obs.content),
    relations: relRows.rows.map((rel) => ({
      from: rel.from_name,
      to: rel.to_name,
      relationType: rel.relation_type,
    })),
  };
}

export async function deleteObservationByIdPg(pool: Pool, id: number): Promise<void> {
  await pool.query(`DELETE FROM observations WHERE id = $1`, [id]);
}

export async function deleteRelationByIdPg(pool: Pool, id: number): Promise<void> {
  await pool.query(`DELETE FROM relations WHERE id = $1`, [id]);
}

export async function createRelationDirectPg(
  pool: Pool,
  project: string,
  from: string,
  to: string,
  relationType: string
): Promise<{ id: number } | null> {
  const fromId = await findEntityId(pool, project, from);
  const toId = await findEntityId(pool, project, to);
  if (fromId === null || toId === null) return null;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO relations (project, from_entity_id, to_entity_id, relation_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [project, fromId, toId, relationType]
  );
  return rows[0] ?? null;
}
