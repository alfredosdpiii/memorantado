import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHttpApp } from "../src/main.js";
import { createTestStore, HOST_HEADER, type TestStore } from "./helpers.js";

let app: FastifyInstance;
let testStore: TestStore;

beforeEach(async () => {
  testStore = await createTestStore();
  app = await createHttpApp({
    store: testStore.store,
    logger: false,
    serveStatic: false,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await testStore.cleanup();
});

async function call(method: "GET" | "POST" | "DELETE", url: string, payload?: object) {
  const response = await app.inject({ headers: HOST_HEADER, method, url, payload });
  return { status: response.statusCode, body: response.json() };
}

describe("curation API", () => {
  it("stores, recalls, supersedes and forgets a keyed, tagged memory", async () => {
    const created = await call("POST", "/api/semantic-memories", {
      project: "ultron",
      subject: "launcher",
      content: "The launcher lives in bin/pi.",
      key: "doc-1",
      tags: ["ultron:project:p1"],
      metadata: { ultron_operation: "op-1" },
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ key: "doc-1", tags: ["ultron:project:p1"] });

    const byKey = await call(
      "GET",
      "/api/semantic-memories/by-key?project=ultron&key=doc-1"
    );
    expect(byKey.body.id).toBe(created.body.id);

    const recalled = await call("POST", "/api/retrieve-context", {
      project: "ultron",
      query: "launcher",
      tags: ["ultron:project:p1", "ultron:global:me"],
      tagsMatch: "any",
    });
    expect(recalled.body.memories[0].memory).toMatchObject({
      id: created.body.id,
      metadata: { ultron_operation: "op-1" },
    });

    const listed = await call(
      "GET",
      "/api/semantic-memories?project=ultron&tags=ultron:project:p1&tagsMatch=exact&sort=confirmed"
    );
    expect(listed.body.map((memory: { id: number }) => memory.id)).toEqual([
      created.body.id,
    ]);

    const superseded = await call(
      "POST",
      `/api/semantic-memories/${created.body.id}/supersede`,
      { project: "ultron", content: "The launcher lives in bin/ultron." }
    );
    expect(superseded.body).toMatchObject({
      supersedesId: created.body.id,
      key: "doc-1",
    });
    const again = await call(
      "POST",
      `/api/semantic-memories/${created.body.id}/supersede`,
      {
        project: "ultron",
        content: "Again.",
      }
    );
    expect(again).toMatchObject({ status: 409, body: { error: "conflict" } });

    const confirmed = await call(
      "POST",
      `/api/semantic-memories/${superseded.body.id}/confirm`,
      { project: "ultron" }
    );
    expect(confirmed.body.lastConfirmedAt).toBeTruthy();

    const deleted = await call(
      "DELETE",
      `/api/semantic-memories/${superseded.body.id}?project=ultron`
    );
    expect(deleted.body).toEqual({ deleted: true });
    const gone = await call(
      "GET",
      "/api/semantic-memories/by-key?project=ultron&key=doc-1"
    );
    expect(gone).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it("invalidates and flags conflicts", async () => {
    const left = await call("POST", "/api/semantic-memories", {
      subject: "x",
      content: "X is 1.",
    });
    const right = await call("POST", "/api/semantic-memories", {
      subject: "x",
      content: "X is 2.",
    });
    const conflict = await call("POST", "/api/memory-conflicts", {
      memoryId: left.body.id,
      conflictingId: right.body.id,
      reason: "dreaming found a contradiction",
    });
    expect(conflict.body).toMatchObject({ resolutionStatus: "open" });
    const missing = await call("POST", "/api/memory-conflicts", {
      memoryId: left.body.id,
      conflictingId: 999_999,
      reason: "nope",
    });
    expect(missing.status).toBe(404);

    const foreign = await call(
      "POST",
      `/api/memory-conflicts/${conflict.body.id}/resolve`,
      {
        resolvedMemoryId: 999_999,
      }
    );
    expect(foreign).toMatchObject({
      status: 500,
      body: { message: "resolved memory must belong to the conflict" },
    });

    const invalid = await call(
      "POST",
      `/api/semantic-memories/${left.body.id}/invalidate`,
      {
        reason: "wrong",
      }
    );
    expect(invalid.body).toMatchObject({ status: "invalidated" });
    const read = await call("GET", `/api/semantic-memories/${left.body.id}`);
    expect(read.body.metadata.invalidation.reason).toBe("wrong");
  });

  it("records file snapshots as evidence and reports stale memories", async () => {
    const content = "pub fn launch() {}\n";
    const snapshot = await call("POST", "/api/file-snapshots", {
      source: "repo://src/lib.rs",
      content,
      tags: ["ultron:project:p1"],
    });
    expect(snapshot.body).toMatchObject({
      created: true,
      snapshot: { contentHash: createHash("sha256").update(content).digest("hex") },
    });
    const memory = await call("POST", "/api/semantic-memories", {
      subject: "lib",
      content: "lib.rs exports launch.",
      sourceEpisodeId: snapshot.body.snapshot.episodeId,
      quote: "pub fn launch()",
    });
    const stale = await call("POST", "/api/file-snapshots/stale", {
      files: [{ source: "repo://src/lib.rs", contentHash: "0".repeat(64) }],
    });
    expect(stale.body.stale).toEqual([
      {
        memoryId: memory.body.id,
        source: "repo://src/lib.rs",
        currentHash: "0".repeat(64),
        evidenceHashes: [snapshot.body.snapshot.contentHash],
      },
    ]);
  });

  it("answers invalid input with 400", async () => {
    const cases: Array<[string, string, object | undefined]> = [
      ["POST", "/api/file-snapshots", { source: "src/lib.rs", content: "x" }],
      ["POST", "/api/file-snapshots/stale", { files: [] }],
      [
        "POST",
        "/api/file-snapshots/stale",
        { files: [{ source: "repo://a", contentHash: "x" }] },
      ],
      ["POST", "/api/retrieve-context", { query: "x", tags: ["a b"] }],
      ["POST", "/api/retrieve-context", { query: "x", tags: ["a"], tagsMatch: "some" }],
      ["GET", "/api/semantic-memories?confirmedBefore=yesterday", undefined],
      ["GET", "/api/semantic-memories/abc", undefined],
      ["POST", "/api/semantic-memories/1/supersede", { content: "" }],
      ["POST", "/api/semantic-memories/1/confirm", { sourceEpisodeId: "1" }],
      ["GET", "/api/semantic-memories/by-key", undefined],
    ];
    for (const [method, url, payload] of cases) {
      const response = await call(method as "GET" | "POST", url, payload);
      expect([url, response.status, response.body.error]).toEqual([
        url,
        400,
        "invalid_input",
      ]);
    }
  });
});
