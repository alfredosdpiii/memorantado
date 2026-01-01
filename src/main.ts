import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { installSecurity } from "./security.js";
import { registerMcpRoutes } from "./mcp/http.js";
import { registerApiRoutes } from "./api/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.MEMORANTADO_PORT ?? 3789);
const HOST = "127.0.0.1";
const WEB_DIST = path.resolve(__dirname, "../dist/web");

async function main(): Promise<void> {
  const app = Fastify({
    logger: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  const db = openDb();
  migrate(db);

  installSecurity(app, { port: PORT });

  registerMcpRoutes(app, { db });
  registerApiRoutes(app, { db });

  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: "/",
    decorateReply: false,
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/mcp")) {
      reply.code(404);
      return { error: "not_found" };
    }
    return reply.sendFile("index.html");
  });

  await app.listen({ port: PORT, host: HOST });
  console.log(`memorantado running at http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
