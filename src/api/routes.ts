import type { FastifyInstance } from "fastify";
import * as exchange from "../db/exchange.js";
import * as wiki from "../wiki/obsidian.js";
import type Database from "better-sqlite3";
import { resolveProject } from "../mcp/project.js";
import { isFeatureEnabled } from "../featureFlags.js";
import type { HttpMetrics } from "../observability.js";
import * as graph from "../db/graph.js";
import * as hybrid from "../db/hybridMemory.js";
import * as timeline from "../db/timeline.js";
import { backfillConfiguredEmbeddings } from "../memory/embeddingBackfill.js";

type RegisterApiRoutesOpts = {
  db: Database.Database;
  metrics: HttpMetrics;
};

export function registerApiRoutes(
  app: FastifyInstance,
  opts: RegisterApiRoutesOpts
): void {
  const { db, metrics } = opts;

  app.get("/api/health", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    };
  });

  if (isFeatureEnabled("enableMetricsEndpoint")) {
    app.get("/api/metrics", async (_req, reply) => {
      reply.type("text/plain; version=0.0.4; charset=utf-8");
      return metrics.toPrometheus();
    });
  }

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

  app.get<{
    Querystring: { project?: string; session?: string; limit?: string; offset?: string };
  }>("/api/episodes", async (req) => {
    const project = resolveProject(req.query.project);
    return hybrid.listEpisodes(db, project, {
      session: req.query.session,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
    });
  });

  app.post<{
    Body: {
      project?: string;
      session?: string;
      actor?: string;
      role?: string;
      content: string;
      source?: string;
      metadata?: Record<string, unknown>;
      extract?: boolean;
    };
  }>("/api/episodes", async (req) => {
    const project = resolveProject(req.body.project);
    const episode = hybrid.appendEpisode(db, project, {
      session: req.body.session,
      actor: req.body.actor,
      role: req.body.role,
      content: req.body.content,
      source: req.body.source,
      metadata: req.body.metadata,
    });
    const memories = req.body.extract
      ? await hybrid.extractMemories(db, project, episode.id)
      : [];
    return { episode, memories };
  });

  app.get<{
    Params: { id: string };
    Querystring: { project?: string };
  }>("/api/episodes/:id", async (req, reply) => {
    const project = resolveProject(req.query.project);
    const episode = hybrid.getEpisode(db, project, parseInt(req.params.id, 10));
    if (!episode) {
      reply.code(404);
      return { error: "not_found" };
    }
    return episode;
  });

  app.post<{
    Params: { id: string };
    Body: { project?: string };
  }>("/api/episodes/:id/extract", async (req) => {
    const project = resolveProject(req.body.project);
    return {
      memories: await hybrid.extractMemories(db, project, parseInt(req.params.id, 10)),
    };
  });

  app.get<{
    Querystring: {
      project?: string;
      status?: string;
      lifecycleStatus?: "active" | "archived";
      limit?: string;
      offset?: string;
    };
  }>("/api/semantic-memories", async (req) => {
    const project = resolveProject(req.query.project);
    return hybrid.listSemanticMemories(db, project, {
      status: req.query.status,
      lifecycleStatus: req.query.lifecycleStatus,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 100,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
    });
  });

  app.post<{
    Body: Parameters<typeof hybrid.upsertSemanticMemory>[2] & {
      project?: string;
      sourceEpisodeId?: number;
    };
  }>("/api/semantic-memories", async (req) => {
    const project = resolveProject(req.body.project);
    return hybrid.upsertSemanticMemory(db, project, req.body, req.body.sourceEpisodeId);
  });

  app.get<{
    Params: { id: string };
    Querystring: { project?: string };
  }>("/api/semantic-memories/:id/explain", async (req) => {
    const project = resolveProject(req.query.project);
    return hybrid.explainMemory(db, project, parseInt(req.params.id, 10));
  });

  app.post<{
    Params: { id: string };
    Body: {
      project?: string;
      status: "active" | "archived";
      reason?: string;
    };
  }>("/api/semantic-memories/:id/lifecycle", async (req, reply) => {
    const project = resolveProject(req.body.project);
    const memory = hybrid.setMemoryLifecycle(
      db,
      project,
      parseInt(req.params.id, 10),
      req.body.status,
      req.body.reason
    );
    if (!memory) {
      reply.code(404);
      return { error: "not_found" };
    }
    return memory;
  });

  app.post<{
    Body: {
      project?: string;
      query: string;
      limit?: number;
      tokenBudget?: number;
      mode?: "current" | "as_of" | "history" | "all";
      asOf?: string;
      recordedAt?: string;
    };
  }>("/api/retrieve-context", async (req) => {
    const project = resolveProject(req.body.project);
    return hybrid.retrieveContext(db, project, req.body.query, {
      limit: req.body.limit,
      tokenBudget: req.body.tokenBudget,
      mode: req.body.mode,
      asOf: req.body.asOf,
      recordedAt: req.body.recordedAt,
    });
  });

  app.post<{
    Body: { project?: string };
  }>("/api/embeddings/backfill", async (req) => {
    const project = resolveProject(req.body.project);
    return backfillConfiguredEmbeddings(db, project);
  });

  app.get<{
    Querystring: { project?: string; status?: string };
  }>("/api/memory-conflicts", async (req) => {
    const project = resolveProject(req.query.project);
    return hybrid.listConflicts(db, project, req.query.status ?? "open");
  });

  app.post<{
    Params: { id: string };
    Body: {
      project?: string;
      resolvedMemoryId?: number;
      status?: "resolved" | "ignored";
      actor?: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    };
  }>("/api/memory-conflicts/:id/resolve", async (req) => {
    const project = resolveProject(req.body.project);
    return hybrid.resolveConflict(
      db,
      project,
      parseInt(req.params.id, 10),
      req.body.resolvedMemoryId,
      req.body.status ?? "resolved",
      {
        actor: req.body.actor,
        reason: req.body.reason,
        metadata: req.body.metadata,
      }
    );
  });

  app.get<{
    Querystring: { project?: string };
  }>("/api/exchange/jsonl", async (req, reply) => {
    const project = resolveProject(req.query.project);
    reply.type("application/x-ndjson");
    return exchange.exportProjectJsonl(db, project);
  });

  app.post<{
    Body: { project?: string; jsonl: string };
  }>("/api/exchange/jsonl", async (req) => {
    return exchange.importProjectJsonl(db, req.body.jsonl, req.body.project);
  });

  app.post<{
    Body: { project?: string; vaultRoot: string };
  }>("/api/wiki/obsidian", async (req) => {
    const project = resolveProject(req.body.project);
    return wiki.buildObsidianWiki(db, project, req.body.vaultRoot);
  });

  app.post<{
    Body: { project?: string; topK?: number };
  }>("/api/memory-benchmark", async (req) => {
    const project = resolveProject(req.body.project);
    return hybrid.runMemoryBenchmark(db, project, req.body.topK);
  });
}
