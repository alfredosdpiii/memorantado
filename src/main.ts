import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openStore, type MemoryStore } from "./db/store.js";
import {
  createMetrics,
  createRequestId,
  installObservability,
  type HttpMetrics,
} from "./observability.js";
import { installSecurity } from "./security.js";
import { registerMcpRoutes } from "./mcp/http.js";
import { createMcpServer } from "./mcp/server.js";
import { registerApiRoutes } from "./api/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.MEMORANTADO_PORT ?? 3789);
const HOST = "127.0.0.1";
const WEB_DIST = path.resolve(__dirname, "web");
const STDIO_MODE = process.argv.includes("--stdio");

type CreateHttpAppOpts = {
  store?: MemoryStore;
  logger?: boolean | Record<string, unknown>;
  metrics?: HttpMetrics;
  port?: number;
  serveStatic?: boolean;
  webDist?: string;
};

async function runStdioMode(): Promise<void> {
  const store = await openStore();

  const server = createMcpServer(store, {});
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function createHttpApp(
  opts: CreateHttpAppOpts = {}
): Promise<FastifyInstance> {
  const port = opts.port ?? PORT;
  const store = opts.store ?? (await openStore());
  const metrics = opts.metrics ?? createMetrics();
  const app = Fastify({
    bodyLimit: 5 * 1024 * 1024,
    genReqId: (req) => {
      const id = req.headers["x-request-id"];
      return typeof id === "string" && id.trim() ? id : createRequestId();
    },
    logger: opts.logger ?? {
      level: process.env.LOG_LEVEL ?? "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.set-cookie",
        "req.headers.x-api-key",
        "res.headers.set-cookie",
      ],
    },
    requestIdHeader: "x-request-id",
  });

  if (!opts.store) {
    app.addHook("onClose", async () => {
      await store.close();
    });
  }

  installSecurity(app, { port });
  installObservability(app, { metrics });
  registerMcpRoutes(app, { store });
  registerApiRoutes(app, { store, metrics });

  if (opts.serveStatic !== false) {
    await app.register(fastifyStatic, {
      root: opts.webDist ?? WEB_DIST,
      prefix: "/",
    });
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/mcp")) {
      reply.code(404);
      return { error: "not_found" };
    }
    return reply.sendFile("index.html");
  });

  return app;
}

async function runHttpMode(): Promise<void> {
  const app = await createHttpApp();
  await app.listen({ port: PORT, host: HOST });
  console.log(`memorantado running at http://${HOST}:${PORT}`);
}

export async function main(): Promise<void> {
  if (STDIO_MODE) {
    await runStdioMode();
  } else {
    await runHttpMode();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
