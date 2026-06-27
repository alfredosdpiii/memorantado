import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHttpApp } from "../src/main.js";
import { createTestDb, HOST_HEADER, type TestDb } from "./helpers.js";

let app: FastifyInstance;
let testDb: TestDb;

beforeEach(async () => {
  testDb = createTestDb();
  app = await createHttpApp({
    db: testDb.db,
    logger: false,
    serveStatic: false,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  testDb.cleanup();
});

describe("API routes", () => {
  it("reports health and request IDs", async () => {
    const response = await app.inject({
      headers: { ...HOST_HEADER, "x-request-id": "req-test" },
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("req-test");
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("creates and reads graph entities through HTTP", async () => {
    const create = await app.inject({
      headers: HOST_HEADER,
      method: "POST",
      payload: {
        entityType: "person",
        name: "Ada",
        observations: ["writes tests"],
        project: "api",
      },
      url: "/api/entity",
    });

    expect(create.statusCode).toBe(200);

    const entity = await app.inject({
      headers: HOST_HEADER,
      method: "GET",
      url: "/api/entity/Ada?project=api",
    });

    expect(entity.statusCode).toBe(200);
    expect(entity.json()).toMatchObject({
      entityType: "person",
      name: "Ada",
      observations: ["writes tests"],
    });
  });

  it("creates, searches, and deletes memory items through HTTP", async () => {
    const created = await app.inject({
      headers: HOST_HEADER,
      method: "POST",
      payload: {
        content: "remember local agent readiness",
        kind: "note",
        project: "api",
        tags: ["readiness"],
        title: "Readiness",
      },
      url: "/api/memory-items",
    });

    expect(created.statusCode).toBe(200);
    const id = created.json<{ id: number }>().id;

    const search = await app.inject({
      headers: HOST_HEADER,
      method: "GET",
      url: "/api/memory-items?project=api&q=readiness",
    });
    expect(search.json()).toHaveLength(1);

    const deleted = await app.inject({
      headers: HOST_HEADER,
      method: "DELETE",
      url: `/api/memory-items/${id}?project=api`,
    });
    expect(deleted.json()).toEqual({ deleted: true });
  });

  it("exports Prometheus metrics", async () => {
    await app.inject({
      headers: HOST_HEADER,
      method: "GET",
      url: "/api/health",
    });

    const metrics = await app.inject({
      headers: HOST_HEADER,
      method: "GET",
      url: "/api/metrics",
    });

    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("memorantado_http_requests_total");
  });
});
