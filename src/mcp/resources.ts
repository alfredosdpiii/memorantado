import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryStore } from "../db/store.js";

export function registerMemoryResources(server: McpServer, store: MemoryStore): void {
  server.registerResource(
    "semantic-memory",
    new ResourceTemplate("memory://{project}/memories/{id}", { list: undefined }),
    {
      title: "Semantic memory",
      description:
        "Direct, read-only access to a semantic memory and its evidence history.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const project = decodeURIComponent(String(variables.project));
      const memoryId = Number.parseInt(String(variables.id), 10);
      return jsonResource(uri, await store.explainMemory(project, memoryId));
    }
  );
  server.registerResource(
    "memory-episode",
    new ResourceTemplate("memory://{project}/episodes/{id}", { list: undefined }),
    {
      title: "Memory episode",
      description: "Direct, read-only access to an ingested episode.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const project = decodeURIComponent(String(variables.project));
      const episodeId = Number.parseInt(String(variables.id), 10);
      return jsonResource(uri, await store.getEpisode(project, episodeId));
    }
  );
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
