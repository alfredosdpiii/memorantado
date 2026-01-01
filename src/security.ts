import type { FastifyInstance } from "fastify";

function isLoopback(addr?: string): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr.startsWith("::ffff:127.0.0.1")
  );
}

export function installSecurity(
  app: FastifyInstance,
  opts: { port: number }
): void {
  const allowedHosts = new Set([
    `127.0.0.1:${opts.port}`,
    `localhost:${opts.port}`,
    `[::1]:${opts.port}`,
  ]);

  const allowedOrigins = new Set([
    `http://127.0.0.1:${opts.port}`,
    `http://localhost:${opts.port}`,
  ]);

  app.addHook("preHandler", async (req, reply) => {
    if (!isLoopback(req.ip)) {
      return reply.code(403).send({ error: "loopback_only" });
    }

    const host = req.headers.host;
    if (!host || !allowedHosts.has(host)) {
      return reply.code(403).send({ error: "invalid_host" });
    }

    const origin = req.headers.origin;

    if (req.url.startsWith("/mcp")) {
      if (origin) {
        return reply.code(403).send({ error: "origin_not_allowed_for_mcp" });
      }
      return;
    }

    if (req.url.startsWith("/api/")) {
      if (origin && !allowedOrigins.has(origin)) {
        return reply.code(403).send({ error: "origin_not_allowed" });
      }
      return;
    }
  });
}
