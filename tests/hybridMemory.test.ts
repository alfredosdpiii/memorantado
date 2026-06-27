import { afterEach, describe, expect, it } from "vitest";
import * as hybrid from "../src/db/hybridMemory.js";
import { createTestDb, type TestDb } from "./helpers.js";

let current: TestDb | undefined;

function db() {
  current = createTestDb();
  return current.db;
}

afterEach(() => {
  current?.cleanup();
  current = undefined;
});

describe("hybrid memory", () => {
  it("appends episodes, extracts semantic memories, and retrieves context", async () => {
    const database = db();
    const episode = hybrid.appendEpisode(database, "hybrid", {
      actor: "Ada",
      content: "Ada prefers SQLite for local agent memory.",
      source: "test",
    });

    const memories = await hybrid.extractMemories(database, "hybrid", episode.id);
    const context = hybrid.retrieveContext(database, "hybrid", "What does Ada prefer?");

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
    });
    expect(context.context.toLowerCase()).toContain("sqlite");
  });

  it("reinforces duplicate memories and records conflicts", () => {
    const database = db();
    const first = hybrid.upsertSemanticMemory(database, "hybrid", {
      subject: "Ada",
      predicate: "prefers",
      content: "Ada prefers SQLite.",
      importance: 0.4,
    });
    const duplicate = hybrid.upsertSemanticMemory(database, "hybrid", {
      subject: "Ada",
      predicate: "prefers",
      content: "Ada prefers SQLite.",
      importance: 0.9,
    });
    hybrid.upsertSemanticMemory(database, "hybrid", {
      subject: "Ada",
      predicate: "prefers",
      content: "Ada prefers Postgres.",
    });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.confidence).toBeGreaterThan(first.confidence);
    expect(duplicate.importance).toBe(0.9);
    expect(hybrid.listConflicts(database, "hybrid")).toHaveLength(1);
  });

  it("runs the local benchmark after extraction completes", async () => {
    const database = db();
    const result = await hybrid.runMemoryBenchmark(database, "hybrid");

    expect(result.metrics.accuracy).toBe(1);
    expect(result.report).toContain("Accuracy: 2/2");
  });
});
