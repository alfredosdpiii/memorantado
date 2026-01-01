import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server.js";
import { InMemoryEventStore } from "./eventStore.js";

type RegisterMcpRoutesOpts = {
  db: Database.Database;
  maxSessions?: number;
  defaultProject?: string;
};

export function registerMcpRoutes(
  app: FastifyInstance,
  opts: RegisterMcpRoutesOpts
): void {
  const maxSessions = opts.maxSessions ?? 3;
  const globalDefaultProject = opts.defaultProject;
  const transports = new Map<string, StreamableHTTPServerTransport>();

  function evictIfNeeded(): void {
    if (transports.size >= maxSessions) {
      const err = new Error("Too many MCP sessions") as Error & { statusCode: number };
      err.statusCode = 429;
      throw err;
    }
  }

  app.post("/mcp", async (req, reply) => {
    const body = req.body as unknown;
    const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;

    try {
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          reply.code(400);
          return {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Unknown mcp-session-id" },
            id: null,
          };
        }

        reply.hijack();
        await transport.handleRequest(req.raw, reply.raw, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        reply.code(400);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: missing mcp-session-id and not an initialize request",
          },
          id: null,
        };
      }

      evictIfNeeded();

      const eventStore = new InMemoryEventStore({
        ttlMs: 15 * 60 * 1000,
        maxEventsPerStream: 5000,
      });

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        onsessioninitialized: (sid) => {
          transports.set(sid, transport!);
        },
      });

      transport.onclose = () => {
        const sid = transport!.sessionId;
        if (sid) transports.delete(sid);
      };

      const urlProject = (req.query as { project?: string }).project;
      const defaultProject = urlProject ?? globalDefaultProject;
      const server = createMcpServer(opts.db, { defaultProject });
      await server.connect(transport);

      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, body);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      req.log.error({ err }, "Error handling /mcp POST");
      if (!reply.sent) reply.code(status).send({ error: "mcp_post_failed" });
    }
  });

  app.get("/mcp", async (req, reply) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      reply.code(400).send("Invalid or missing mcp-session-id");
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      reply.code(400).send("Invalid or missing mcp-session-id");
      return;
    }

    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw);
  });

  app.delete("/mcp", async (req, reply) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      reply.code(400).send("Invalid or missing mcp-session-id");
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      reply.code(400).send("Invalid or missing mcp-session-id");
      return;
    }

    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw);
  });

  app.addHook("onClose", async () => {
    for (const t of transports.values()) {
      try {
        await t.close();
      } catch {
        // ignore
      }
    }
    transports.clear();
  });
}
