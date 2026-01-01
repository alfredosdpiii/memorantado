import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import { resolveProject } from "./project.js";
import * as graph from "../db/graph.js";
import * as timeline from "../db/timeline.js";

type CreateMcpServerOpts = {
  defaultProject?: string;
};

export function createMcpServer(
  db: Database.Database,
  opts: CreateMcpServerOpts = {}
): McpServer {
  const { defaultProject } = opts;

  const server = new McpServer({
    name: "memorantado",
    version: "0.1.1",
  });

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
      const result = graph.createEntities(db, project, input.entities);
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
      const result = graph.createRelations(db, project, input.relations);
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
      const result = graph.addObservations(db, project, input.observations);
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
      graph.deleteEntities(db, project, input.entityNames);
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
      graph.deleteObservations(db, project, input.deletions);
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
      graph.deleteRelations(db, project, input.relations);
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
      const result = graph.readGraph(db, project);
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
      const result = graph.searchNodes(db, project, input.query);
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
      const result = graph.openNodes(db, project, input.names);
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
      const result = timeline.appendMemoryItem(db, project, {
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
      const result = timeline.searchMemoryItems(db, project, input.query, {
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
      const result = timeline.getMemoryItem(db, project, input.id);
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
      const deleted = timeline.deleteMemoryItem(db, project, input.id);
      return { content: [{ type: "text", text: deleted ? "Deleted" : "Not found" }] };
    }
  );

  return server;
}
