import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { resolveProject } from "../mcp/project.js";
import * as graph from "../db/graph.js";
import * as timeline from "../db/timeline.js";

type RegisterApiRoutesOpts = {
  db: Database.Database;
};

export function registerApiRoutes(
  app: FastifyInstance,
  opts: RegisterApiRoutesOpts
): void {
  const { db } = opts;

  app.get("/api/projects", async () => {
    const projects = timeline.getProjects(db);
    return { projects };
  });

  app.get<{
    Querystring: { project?: string; q?: string };
  }>("/api/search", async (req) => {
    const project = resolveProject(req.query.project);
    const q = req.query.q?.trim() ?? "";

    if (!q) {
      return { entities: [], relations: [], memoryItems: [] };
    }

    const graphResult = graph.searchNodes(db, project, q);
    const memoryItems = timeline.searchMemoryItems(db, project, q, { limit: 50 });

    return {
      entities: graphResult.entities,
      relations: graphResult.relations,
      memoryItems,
    };
  });

  app.get<{
    Querystring: { project?: string };
  }>("/api/graph", async (req) => {
    const project = resolveProject(req.query.project);
    return graph.readGraph(db, project);
  });

  app.get<{
    Params: { name: string };
    Querystring: { project?: string };
  }>("/api/entity/:name", async (req, reply) => {
    const project = resolveProject(req.query.project);
    const entity = graph.getEntityByName(db, project, req.params.name);

    if (!entity) {
      reply.code(404);
      return { error: "not_found" };
    }

    return entity;
  });

  app.post<{
    Body: {
      project?: string;
      name: string;
      entityType: string;
      observations?: string[];
    };
  }>("/api/entity", async (req) => {
    const project = resolveProject(req.body.project);
    const result = graph.createEntities(db, project, [
      {
        name: req.body.name,
        entityType: req.body.entityType,
        observations: req.body.observations,
      },
    ]);
    return result[0] ?? null;
  });

  app.post<{
    Params: { name: string };
    Body: { project?: string; content: string };
  }>("/api/entity/:name/observations", async (req, reply) => {
    const project = resolveProject(req.body.project);
    const result = graph.addObservations(db, project, [
      { entityName: req.params.name, contents: [req.body.content] },
    ]);

    if (!result.length || !result[0].addedObservations.length) {
      reply.code(400);
      return { error: "entity_not_found_or_duplicate" };
    }

    return { added: result[0].addedObservations };
  });

  app.delete<{
    Params: { id: string };
  }>("/api/observation/:id", async (req) => {
    const id = parseInt(req.params.id, 10);
    graph.deleteObservationById(db, id);
    return { deleted: true };
  });

  app.post<{
    Body: {
      project?: string;
      from: string;
      to: string;
      relationType: string;
    };
  }>("/api/relation", async (req, reply) => {
    const project = resolveProject(req.body.project);
    const result = graph.createRelationDirect(
      db,
      project,
      req.body.from,
      req.body.to,
      req.body.relationType
    );

    if (!result) {
      reply.code(400);
      return { error: "entities_not_found_or_duplicate" };
    }

    return { id: result.id };
  });

  app.delete<{
    Params: { id: string };
  }>("/api/relation/:id", async (req) => {
    const id = parseInt(req.params.id, 10);
    graph.deleteRelationById(db, id);
    return { deleted: true };
  });

  app.get<{
    Querystring: {
      project?: string;
      q?: string;
      kind?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/memory-items", async (req) => {
    const project = resolveProject(req.query.project);
    const q = req.query.q?.trim() ?? "";
    const kind = req.query.kind;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;

    if (q) {
      return timeline.searchMemoryItems(db, project, q, { kind, limit, offset });
    }
    return timeline.listMemoryItems(db, project, { kind, limit, offset });
  });

  app.post<{
    Body: {
      project?: string;
      kind: string;
      title?: string;
      content: string;
      tags?: string[];
      source?: string;
    };
  }>("/api/memory-items", async (req) => {
    const project = resolveProject(req.body.project);
    return timeline.appendMemoryItem(db, project, {
      kind: req.body.kind,
      title: req.body.title,
      content: req.body.content,
      tags: req.body.tags,
      source: req.body.source,
    });
  });

  app.get<{
    Params: { id: string };
    Querystring: { project?: string };
  }>("/api/memory-items/:id", async (req, reply) => {
    const project = resolveProject(req.query.project);
    const id = parseInt(req.params.id, 10);
    const item = timeline.getMemoryItem(db, project, id);

    if (!item) {
      reply.code(404);
      return { error: "not_found" };
    }

    return item;
  });

  app.delete<{
    Params: { id: string };
    Querystring: { project?: string };
  }>("/api/memory-items/:id", async (req) => {
    const project = resolveProject(req.query.project);
    const id = parseInt(req.params.id, 10);
    const deleted = timeline.deleteMemoryItem(db, project, id);
    return { deleted };
  });
}
