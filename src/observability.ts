import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

type RouteKey = `${string} ${string} ${number}`;

export type HttpMetrics = {
  observe(req: FastifyRequest, statusCode: number, durationMs: number): void;
  toPrometheus(): string;
};

export function createMetrics(): HttpMetrics {
  const counters = new Map<RouteKey, number>();
  const durations = new Map<RouteKey, number>();

  return {
    observe(req, statusCode, durationMs) {
      const method = req.method;
      const route = req.routeOptions.url ?? req.url.split("?")[0] ?? "unknown";
      const key: RouteKey = `${method} ${route} ${statusCode}`;
      counters.set(key, (counters.get(key) ?? 0) + 1);
      durations.set(key, (durations.get(key) ?? 0) + durationMs / 1000);
    },
    toPrometheus() {
      const lines = [
        "# HELP memorantado_http_requests_total Total HTTP requests.",
        "# TYPE memorantado_http_requests_total counter",
      ];

      for (const [key, count] of counters.entries()) {
        const [method, route, status] = key.split(" ");
        lines.push(
          `memorantado_http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`
        );
      }

      lines.push(
        "# HELP memorantado_http_request_duration_seconds_total Total HTTP request duration.",
        "# TYPE memorantado_http_request_duration_seconds_total counter"
      );

      for (const [key, duration] of durations.entries()) {
        const [method, route, status] = key.split(" ");
        lines.push(
          `memorantado_http_request_duration_seconds_total{method="${method}",route="${route}",status="${status}"} ${duration.toFixed(6)}`
        );
      }

      return `${lines.join("\n")}\n`;
    },
  };
}

export function createRequestId(): string {
  return randomUUID();
}

export function installObservability(
  app: FastifyInstance,
  opts: { metrics: HttpMetrics }
): void {
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.addHook("onResponse", async (req, reply) => {
    opts.metrics.observe(req, reply.statusCode, reply.elapsedTime);
  });
}
