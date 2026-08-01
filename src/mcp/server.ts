import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as wiki from "../wiki/obsidian.js";
import { z } from "zod";
import { resolveProject } from "./project.js";
import type { MemoryStore } from "../db/store.js";
import { registerMemoryResources } from "./resources.js";

type CreateMcpServerOpts = {
  defaultProject?: string;
};

export function createMcpServer(
  store: MemoryStore,
  opts: CreateMcpServerOpts = {}
): McpServer {
  const { defaultProject } = opts;

  const server = new McpServer({
    name: "memorantado",
    version: "0.2.1",
  });

  registerMemoryResources(server, store);

  server.tool(
    "create_entities",
    {
      project: z.string().optional(),
      entities: z.array(
        z.object({
          name: z.string().min(1),
          entityType: z.string().min(1),
          observations: z.array(z.string()).default([]),
        })
      ),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.createEntities(project, input.entities);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "create_relations",
    {
      project: z.string().optional(),
      relations: z.array(
        z.object({
          from: z.string().min(1),
          to: z.string().min(1),
          relationType: z.string().min(1),
        })
      ),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.createRelations(project, input.relations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "add_observations",
    {
      project: z.string().optional(),
      observations: z.array(
        z.object({
          entityName: z.string().min(1),
          contents: z.array(z.string()),
        })
      ),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.addObservations(project, input.observations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "delete_entities",
    {
      project: z.string().optional(),
      entityNames: z.array(z.string()),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      await store.deleteEntities(project, input.entityNames);
      return { content: [{ type: "text", text: "Deleted" }] };
    }
  );

  server.tool(
    "delete_observations",
    {
      project: z.string().optional(),
      deletions: z.array(
        z.object({
          entityName: z.string().min(1),
          observations: z.array(z.string()),
        })
      ),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      await store.deleteObservations(project, input.deletions);
      return { content: [{ type: "text", text: "Deleted" }] };
    }
  );

  server.tool(
    "delete_relations",
    {
      project: z.string().optional(),
      relations: z.array(
        z.object({
          from: z.string().min(1),
          to: z.string().min(1),
          relationType: z.string().min(1),
        })
      ),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      await store.deleteRelations(project, input.relations);
      return { content: [{ type: "text", text: "Deleted" }] };
    }
  );

  server.tool(
    "read_graph",
    {
      project: z.string().optional(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.readGraph(project);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_nodes",
    {
      project: z.string().optional(),
      query: z.string().min(1),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.searchNodes(project, input.query);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "open_nodes",
    {
      project: z.string().optional(),
      names: z.array(z.string()),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.openNodes(project, input.names);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "append_memory_item",
    {
      project: z.string().optional(),
      kind: z.string().min(1),
      title: z.string().optional(),
      content: z.string().min(1),
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.appendMemoryItem(project, {
        kind: input.kind,
        title: input.title,
        content: input.content,
        tags: input.tags,
        source: input.source,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_memory_items",
    {
      project: z.string().optional(),
      query: z.string().min(1),
      kind: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.searchMemoryItems(project, input.query, {
        kind: input.kind,
        limit: input.limit,
        offset: input.offset,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_memory_item",
    {
      project: z.string().optional(),
      id: z.number().int().positive(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.getMemoryItem(project, input.id);
      if (!result) {
        return { content: [{ type: "text", text: "Not found" }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "delete_memory_item",
    {
      project: z.string().optional(),
      id: z.number().int().positive(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const deleted = await store.deleteMemoryItem(project, input.id);
      return { content: [{ type: "text", text: deleted ? "Deleted" : "Not found" }] };
    }
  );

  server.tool(
    "append_episode",
    {
      project: z.string().optional(),
      session: z.string().optional(),
      actor: z.string().optional(),
      role: z.string().optional(),
      content: z.string().min(1),
      source: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
      extract: z.boolean().default(true),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const episode = await store.appendEpisode(project, {
        session: input.session,
        actor: input.actor,
        role: input.role,
        content: input.content,
        source: input.source,
        metadata: input.metadata,
      });
      const memories = input.extract
        ? await store.extractMemories(project, episode.id)
        : [];
      return {
        content: [{ type: "text", text: JSON.stringify({ episode, memories }, null, 2) }],
      };
    }
  );

  server.tool(
    "extract_episode_memories",
    {
      project: z.string().optional(),
      episodeId: z.number().int().positive(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.extractMemories(project, input.episodeId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "retrieve_memory_context",
    {
      project: z.string().optional(),
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
      tokenBudget: z.number().int().positive().max(12000).optional(),
      mode: z.enum(["current", "as_of", "history", "all"]).optional(),
      asOf: z.string().datetime().optional(),
      recordedAt: z.string().datetime().optional(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.retrieveContext(project, input.query, {
        limit: input.limit,
        tokenBudget: input.tokenBudget,
        mode: input.mode,
        asOf: input.asOf,
        recordedAt: input.recordedAt,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "list_episodes",
    {
      project: z.string().optional(),
      session: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.listEpisodes(project, {
        session: input.session,
        limit: input.limit,
        offset: input.offset,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "list_semantic_memories",
    {
      project: z.string().optional(),
      status: z.enum(["active", "superseded", "invalidated"]).optional(),
      lifecycleStatus: z.enum(["active", "archived"]).optional(),
      limit: z.number().int().positive().max(200).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.listSemanticMemories(project, {
        status: input.status,
        lifecycleStatus: input.lifecycleStatus,
        limit: input.limit,
        offset: input.offset,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "upsert_semantic_memory",
    {
      project: z.string().optional(),
      scope: z.enum(["user", "agent", "session", "project", "global"]).optional(),
      kind: z.string().optional(),
      subject: z.string().min(1),
      predicate: z.string().optional(),
      object: z.string().optional(),
      content: z.string().min(1),
      confidence: z.number().min(0).max(1).optional(),
      importance: z.number().min(0).max(1).optional(),
      sourceEpisodeId: z.number().int().positive().optional(),
      metadata: z.record(z.unknown()).optional(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.upsertSemanticMemory(
        project,
        input,
        input.sourceEpisodeId
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "explain_semantic_memory",
    {
      project: z.string().optional(),
      memoryId: z.number().int().positive(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.explainMemory(project, input.memoryId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "set_memory_lifecycle",
    {
      project: z.string().optional(),
      memoryId: z.number().int().positive(),
      status: z.enum(["active", "archived"]),
      reason: z.string().optional(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.setMemoryLifecycle(
        project,
        input.memoryId,
        input.status,
        input.reason
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "list_memory_conflicts",
    {
      project: z.string().optional(),
      status: z.enum(["open", "resolved", "ignored"]).default("open"),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.listConflicts(project, input.status);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "resolve_memory_conflict",
    {
      project: z.string().optional(),
      conflictId: z.number().int().positive(),
      resolvedMemoryId: z.number().int().positive().optional(),
      status: z.enum(["resolved", "ignored"]).default("resolved"),
      actor: z.string().optional(),
      reason: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.resolveConflict(
        project,
        input.conflictId,
        input.resolvedMemoryId,
        input.status,
        { actor: input.actor, reason: input.reason, metadata: input.metadata }
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "export_memory_jsonl",
    { project: z.string().optional() },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.exportProjectJsonl(project);
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "import_memory_jsonl",
    {
      project: z.string().optional(),
      jsonl: z.string().min(1),
    },
    async (input) => {
      const result = await store.importProjectJsonl(input.jsonl, input.project);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "build_obsidian_wiki",
    {
      project: z.string().optional(),
      vaultRoot: z.string().min(1),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await wiki.buildObsidianWiki(store, project, input.vaultRoot);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "run_memory_benchmark",
    {
      project: z.string().optional(),
      topK: z.number().int().positive().max(50).optional(),
    },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.runMemoryBenchmark(project, input.topK);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "backfill_embeddings",
    { project: z.string().optional() },
    async (input) => {
      const project = resolveProject(input.project, defaultProject);
      const result = await store.backfillConfiguredEmbeddings(project);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}
