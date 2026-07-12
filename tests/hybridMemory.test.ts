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
    const context = await hybrid.retrieveContext(
      database,
      "hybrid",
      "What does Ada prefer?"
    );

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
    });
    expect(context.context.toLowerCase()).toContain("sqlite");
  });

  it("skips operational completion chatter during extraction", async () => {
    const database = db();
    const episode = hybrid.appendEpisode(database, "hybrid", {
      actor: "assistant",
      content:
        "Completed Horizon 4. The full validation passed. Use SQLite as the canonical store.",
      source: "test",
    });

    const memories = await hybrid.extractMemories(database, "hybrid", episode.id);

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      kind: "preference",
      content: "Use SQLite as the canonical store.",
      metadata: { extractor: "local-rule-v2" },
    });
  });

  it("reinforces duplicates and only conflicts on structured exclusive claims", () => {
    const database = db();
    const first = hybrid.upsertSemanticMemory(database, "hybrid", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "SQLite",
      content: "Ada prefers SQLite.",
      importance: 0.4,
    });
    const duplicate = hybrid.upsertSemanticMemory(database, "hybrid", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "SQLite",
      content: "Ada prefers SQLite.",
      importance: 0.9,
    });
    hybrid.upsertSemanticMemory(database, "hybrid", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "Postgres",
      content: "Ada prefers Postgres.",
    });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.confidence).toBeGreaterThan(first.confidence);
    expect(duplicate.importance).toBe(0.9);
    expect(hybrid.listConflicts(database, "hybrid")).toHaveLength(1);
  });

  it("does not flag generic notes or non-overlapping historical claims", () => {
    const database = db();
    hybrid.upsertSemanticMemory(database, "hybrid", {
      subject: "assistant",
      predicate: "states",
      content: "Implemented temporal memory.",
    });
    hybrid.upsertSemanticMemory(database, "hybrid", {
      subject: "assistant",
      predicate: "states",
      content: "Validation passed.",
    });
    hybrid.upsertSemanticMemory(database, "hybrid", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "Postgres",
      content: "Ada preferred Postgres in 2024.",
      validFrom: "2024-01-01T00:00:00.000Z",
      validTo: "2025-01-01T00:00:00.000Z",
    });
    hybrid.upsertSemanticMemory(database, "hybrid", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "SQLite",
      content: "Ada prefers SQLite in 2025.",
      validFrom: "2025-01-01T00:00:00.000Z",
    });

    expect(hybrid.listConflicts(database, "hybrid")).toHaveLength(0);
  });

  it("fuses BM25, vector, overlap, and priors with exact terms first", async () => {
    const database = db();
    const exact = hybrid.upsertSemanticMemory(database, "hybrid", {
      subject: "deployment",
      predicate: "region",
      object: "eu-west-3",
      content: "Production deployment region is eu-west-3.",
      importance: 0.2,
      confidence: 0.6,
    });
    hybrid.upsertSemanticMemory(database, "hybrid", {
      subject: "deployment",
      predicate: "notes",
      content: "Production deployment documentation mentions regional planning.",
      importance: 1,
      confidence: 1,
    });

    const result = await hybrid.retrieveContext(database, "hybrid", "eu-west-3", {
      limit: 2,
    });
    expect(result.memories[0].memory?.id).toBe(exact.id);
    expect(result.memories[0].scoreParts).toMatchObject({ bm25: 1, overlap: 1 });
  });
  it("does not let importance-only priors introduce irrelevant memories", async () => {
    const database = db();
    hybrid.upsertSemanticMemory(database, "hybrid", {
      subject: "unrelated",
      content: "A highly important note about orbital mechanics.",
      importance: 1,
      confidence: 1,
    });

    const result = await hybrid.retrieveContext(database, "hybrid", "zxqv-no-match", {
      limit: 5,
    });
    expect(result.memories).toEqual([]);
  });
  it("archives memories without deleting their history", async () => {
    const database = db();
    const memory = hybrid.upsertSemanticMemory(database, "hybrid", {
      subject: "deployment",
      predicate: "region",
      object: "eu-west-3",
      content: "Production deployment region is eu-west-3.",
    });

    expect(
      hybrid.setMemoryLifecycle(
        database,
        "hybrid",
        memory.id,
        "archived",
        "obsolete deployment"
      )
    ).toMatchObject({
      id: memory.id,
      lifecycleStatus: "archived",
      archiveReason: "obsolete deployment",
    });
    expect(
      (await hybrid.retrieveContext(database, "hybrid", "eu-west-3")).memories
    ).toEqual([]);
    expect(
      hybrid.listSemanticMemories(database, "hybrid", {
        lifecycleStatus: "archived",
      })
    ).toHaveLength(1);
    expect(hybrid.explainMemory(database, "hybrid", memory.id).versions).toHaveLength(1);

    expect(
      hybrid.setMemoryLifecycle(database, "hybrid", memory.id, "active")
    ).toMatchObject({ lifecycleStatus: "active", archiveReason: null, archivedAt: null });
    expect(
      (await hybrid.retrieveContext(database, "hybrid", "eu-west-3")).memories[0].memory
        ?.id
    ).toBe(memory.id);
  });

  it("runs isolated deterministic mutation benchmarks with comparisons", async () => {
    const database = db();
    const before = hybrid.listSemanticMemories(database, "hybrid").length;
    const first = await hybrid.runMemoryBenchmark(database, "hybrid", 5);
    const second = await hybrid.runMemoryBenchmark(database, "hybrid", 5);

    expect(first.name).toBe("mutation-retrieval-v2");
    expect(first.metrics.cases).toBe(8);
    expect(first.metrics.evidenceSpanAccuracy).toBe(1);
    expect(first.previousMetrics).toBeNull();
    expect(second.previousMetrics).toEqual(first.metrics);
    expect(second.delta).toMatchObject({ recallAtK: 0, mrr: 0, ndcgAtK: 0 });
    expect(second.metrics).toEqual(first.metrics);
    expect(hybrid.listSemanticMemories(database, "hybrid")).toHaveLength(before);
    expect(second.report).toContain("Change from previous run");
    expect(second.report).toContain("not an official product benchmark");
  });
});
