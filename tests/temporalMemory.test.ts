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

describe("temporal memory", () => {
  it("records exact evidence and retrieves claims by valid time", async () => {
    const database = db();
    const episode = hybrid.appendEpisode(database, "temporal", {
      actor: "Ada",
      content: "Preface. Ada uses SQLite. Closing.",
      source: "interview",
      metadata: { observedAt: "2025-01-15T12:00:00.000Z" },
    });
    const memories = await hybrid.extractMemories(database, "temporal", episode.id);
    const memory = memories.find((candidate) => candidate.content === "Ada uses SQLite.");
    expect(memory).toBeDefined();
    const explained = hybrid.explainMemory(database, "temporal", memory!.id);
    expect(explained.evidence[0]).toMatchObject({
      quote: "Ada uses SQLite.",
      spanStart: 9,
      spanEnd: 25,
      source: "interview",
      observedAt: "2025-01-15T12:00:00.000Z",
      extractorId: "local-rule-v2",
    });

    const historical = hybrid.upsertSemanticMemory(database, "temporal", {
      subject: "Ada",
      predicate: "prefers",
      content: "Ada preferred Postgres in 2024.",
      validFrom: "2024-01-01T00:00:00.000Z",
      validTo: "2025-01-01T00:00:00.000Z",
    });
    const current = hybrid.upsertSemanticMemory(database, "temporal", {
      subject: "Ada",
      predicate: "prefers",
      content: "Ada prefers SQLite in 2025.",
      validFrom: "2025-01-01T00:00:00.000Z",
    });
    const asOf2024 = await hybrid.retrieveContext(
      database,
      "temporal",
      "What does Ada prefer?",
      {
        mode: "as_of",
        asOf: "2024-06-01T00:00:00.000Z",
      }
    );
    const asOf2025 = await hybrid.retrieveContext(
      database,
      "temporal",
      "What does Ada prefer?",
      {
        mode: "as_of",
        asOf: "2025-06-01T00:00:00.000Z",
      }
    );
    expect(asOf2024.memories.map((hit) => hit.version?.memoryId)).toContain(
      historical.id
    );
    expect(asOf2024.memories.map((hit) => hit.version?.memoryId)).not.toContain(
      current.id
    );
    expect(asOf2025.memories.map((hit) => hit.version?.memoryId)).toContain(current.id);
    expect(asOf2025.memories.map((hit) => hit.version?.memoryId)).not.toContain(
      historical.id
    );
  });
  it("keeps reinforcement history and conflict resolution audit", async () => {
    const database = db();
    const first = hybrid.upsertSemanticMemory(database, "temporal", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "SQLite",
      content: "Ada prefers SQLite.",
    });
    hybrid.upsertSemanticMemory(database, "temporal", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "SQLite",
      content: "Ada prefers SQLite.",
    });
    const competing = hybrid.upsertSemanticMemory(database, "temporal", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "Postgres",
      content: "Ada prefers Postgres.",
    });
    const conflict = hybrid.listConflicts(database, "temporal")[0];
    hybrid.resolveConflict(database, "temporal", conflict.id, competing.id, "resolved", {
      actor: "reviewer",
      reason: "newer explicit statement",
      metadata: { ticket: "M-1" },
    });
    const explanation = hybrid.explainMemory(database, "temporal", first.id);
    expect(explanation.versions).toHaveLength(2);
    expect(explanation.versions[0].supersedesVersionId).toBe(explanation.versions[1].id);
    expect(explanation.versions[1].status).toBe("superseded");
    expect(explanation.resolutionEvents[0]).toMatchObject({
      actor: "reviewer",
      reason: "newer explicit statement",
      resolvedMemoryId: competing.id,
      metadata: { ticket: "M-1" },
    });
    const current = await hybrid.retrieveContext(database, "temporal", "Ada prefers", {
      mode: "current",
    });
    const history = await hybrid.retrieveContext(database, "temporal", "Ada prefers", {
      mode: "all",
    });
    expect(current.memories.map((hit) => hit.memory?.id)).toContain(competing.id);
    expect(current.memories.map((hit) => hit.memory?.id)).not.toContain(first.id);
    expect(history.memories.map((hit) => hit.version?.memoryId)).toEqual(
      expect.arrayContaining([first.id, competing.id])
    );
    expect(
      hybrid.listSemanticMemories(database, "temporal", { status: "superseded" })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, status: "superseded" }),
      ])
    );
  });
});
