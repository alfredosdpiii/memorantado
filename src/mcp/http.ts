import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server.js";
import { InMemoryEventStore } from "./eventStore.js";
import type { MemoryStore } from "../db/store.js";

type RegisterMcpRoutesOpts = {
  store: MemoryStore;
  defaultProject?: string;
};

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
};

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

export function registerMcpRoutes(
  app: FastifyInstance,
  opts: RegisterMcpRoutesOpts
): void {
  const globalDefaultProject = opts.defaultProject;
  const sessions = new Map<string, SessionEntry>();

  // Periodic cleanup of stale sessions
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        entry.transport.close().catch(() => {});
        sessions.delete(sid);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupInterval.unref(); // Don't keep process alive just for cleanup

  app.post("/mcp", async (req, reply) => {
    const body = req.body as unknown;
    const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;

    try {
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId) {
        const entry = sessions.get(sessionId);
        if (!entry) {
          reply.code(400);
          return {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Unknown mcp-session-id" },
            id: null,
          };
        }

        transport = entry.transport;
        entry.lastActivity = Date.now();

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

      const eventStore = new InMemoryEventStore({
        ttlMs: 15 * 60 * 1000,
        maxEventsPerStream: 5000,
      });

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport: transport!, lastActivity: Date.now() });
        },
      });

      transport.onclose = () => {
        const sid = transport!.sessionId;
        if (sid) sessions.delete(sid);
      };

      const urlProject = (req.query as { project?: string }).project;
      const defaultProject = urlProject ?? globalDefaultProject;
      const server = createMcpServer(opts.store, { defaultProject });
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

    const entry = sessions.get(sessionId);
    if (!entry) {
      reply.code(400).send("Invalid or missing mcp-session-id");
      return;
    }

    entry.lastActivity = Date.now();
    reply.hijack();
    await entry.transport.handleRequest(req.raw, reply.raw);
  });

  app.delete("/mcp", async (req, reply) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      reply.code(400).send("Invalid or missing mcp-session-id");
      return;
    }

    const entry = sessions.get(sessionId);
    if (!entry) {
      reply.code(400).send("Invalid or missing mcp-session-id");
      return;
    }

    reply.hijack();
    await entry.transport.handleRequest(req.raw, reply.raw);
  });

  app.addHook("onClose", async () => {
    clearInterval(cleanupInterval);
    for (const entry of sessions.values()) {
      try {
        await entry.transport.close();
      } catch {
        // ignore
      }
    }
    sessions.clear();
  });
}
