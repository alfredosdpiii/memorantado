import { afterEach, describe, expect, it } from "vitest";
import { createTestStore, type TestStore } from "./helpers.js";

let current: TestStore | undefined;

async function store() {
  current = await createTestStore();
  return current.store;
}

afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

describe("temporal memory", () => {
  it("records exact evidence and retrieves claims by valid time", async () => {
    const database = await store();
    const episode = await database.appendEpisode("temporal", {
      actor: "Ada",
      content: "Preface. Ada uses SQLite. Closing.",
      source: "interview",
      metadata: { observedAt: "2025-01-15T12:00:00.000Z" },
    });
    const memories = await database.extractMemories("temporal", episode.id);
    const memory = memories.find((candidate) => candidate.content === "Ada uses SQLite.");
    expect(memory).toBeDefined();
    const explained = await database.explainMemory("temporal", memory!.id);
    expect(explained.evidence[0]).toMatchObject({
      quote: "Ada uses SQLite.",
      spanStart: 9,
      spanEnd: 25,
      source: "interview",
      observedAt: "2025-01-15T12:00:00.000Z",
      extractorId: "local-rule-v2",
    });

    const historical = await database.upsertSemanticMemory("temporal", {
      subject: "Ada",
      predicate: "prefers",
      content: "Ada preferred Postgres in 2024.",
      validFrom: "2024-01-01T00:00:00.000Z",
      validTo: "2025-01-01T00:00:00.000Z",
    });
    const currentMemory = await database.upsertSemanticMemory("temporal", {
      subject: "Ada",
      predicate: "prefers",
      content: "Ada prefers SQLite in 2025.",
      validFrom: "2025-01-01T00:00:00.000Z",
    });
    const asOf2024 = await database.retrieveContext("temporal", "What does Ada prefer?", {
      mode: "as_of",
      asOf: "2024-06-01T00:00:00.000Z",
    });
    const asOf2025 = await database.retrieveContext("temporal", "What does Ada prefer?", {
      mode: "as_of",
      asOf: "2025-06-01T00:00:00.000Z",
    });
    expect(asOf2024.memories.map((hit) => hit.version?.memoryId)).toContain(
      historical.id
    );
    expect(asOf2024.memories.map((hit) => hit.version?.memoryId)).not.toContain(
      currentMemory.id
    );
    expect(asOf2025.memories.map((hit) => hit.version?.memoryId)).toContain(
      currentMemory.id
    );
    expect(asOf2025.memories.map((hit) => hit.version?.memoryId)).not.toContain(
      historical.id
    );
  });
  it("keeps reinforcement history and conflict resolution audit", async () => {
    const database = await store();
    const first = await database.upsertSemanticMemory("temporal", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "SQLite",
      content: "Ada prefers SQLite.",
    });
    await database.upsertSemanticMemory("temporal", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "SQLite",
      content: "Ada prefers SQLite.",
    });
    const competing = await database.upsertSemanticMemory("temporal", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "Postgres",
      content: "Ada prefers Postgres.",
    });
    const conflict = (await database.listConflicts("temporal"))[0];
    await database.resolveConflict("temporal", conflict.id, competing.id, "resolved", {
      actor: "reviewer",
      reason: "newer explicit statement",
      metadata: { ticket: "M-1" },
    });
    const explanation = await database.explainMemory("temporal", first.id);
    expect(explanation.versions).toHaveLength(2);
    expect(explanation.versions[0].supersedesVersionId).toBe(explanation.versions[1].id);
    expect(explanation.versions[1].status).toBe("superseded");
    expect(explanation.resolutionEvents[0]).toMatchObject({
      actor: "reviewer",
      reason: "newer explicit statement",
      resolvedMemoryId: competing.id,
      metadata: { ticket: "M-1" },
    });
    const currentResult = await database.retrieveContext("temporal", "Ada prefers", {
      mode: "current",
    });
    const history = await database.retrieveContext("temporal", "Ada prefers", {
      mode: "all",
    });
    expect(currentResult.memories.map((hit) => hit.memory?.id)).toContain(competing.id);
    expect(currentResult.memories.map((hit) => hit.memory?.id)).not.toContain(first.id);
    expect(history.memories.map((hit) => hit.version?.memoryId)).toEqual(
      expect.arrayContaining([first.id, competing.id])
    );
    expect(
      await database.listSemanticMemories("temporal", { status: "superseded" })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, status: "superseded" }),
      ])
    );
  });
});
