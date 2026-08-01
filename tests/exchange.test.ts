import { afterEach, describe, expect, it } from "vitest";
import { createTestStore, type TestStore } from "./helpers.js";

const databases: TestStore[] = [];

async function store() {
  const testStore = await createTestStore();
  databases.push(testStore);
  return testStore.store;
}

afterEach(async () => {
  while (databases.length) await databases.pop()!.cleanup();
});

describe("JSONL exchange", () => {
  it("round-trips hybrid memory without losing IDs, evidence, or audit", async () => {
    const source = await store();
    const episode = await source.appendEpisode("source", {
      actor: "Ada",
      content: "Ada prefers SQLite.",
      source: "test",
      metadata: { observedAt: "2025-01-01T00:00:00.000Z" },
    });
    const first = await source.upsertSemanticMemory(
      "source",
      {
        kind: "preference",
        subject: "Ada",
        predicate: "prefers",
        object: "SQLite",
        content: "Ada prefers SQLite.",
      },
      episode.id,
      { quote: "Ada prefers SQLite.", spanStart: 0 }
    );
    const competing = await source.upsertSemanticMemory("source", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "Postgres",
      content: "Ada prefers Postgres.",
    });
    const conflict = (await source.listConflicts("source"))[0];
    await source.resolveConflict("source", conflict.id, competing.id, "resolved", {
      actor: "reviewer",
      reason: "verified",
    });

    const jsonl = await source.exportProjectJsonl("source");
    const destination = await store();
    await destination.importProjectJsonl(jsonl, "copy");

    const copied = await destination.explainMemory("copy", first.id);
    expect(copied.memory).toMatchObject({ id: first.id, project: "copy" });
    expect(copied.evidence[0]).toMatchObject({
      episodeId: episode.id,
      quote: first.content,
    });
    expect(copied.resolutionEvents[0]).toMatchObject({
      actor: "reviewer",
      reason: "verified",
    });
    expect(
      (await destination.retrieveContext("copy", "What does Ada prefer?")).context
    ).toContain("Ada prefers");
  });

  it("refuses to merge into a non-empty project", async () => {
    const source = await store();
    await source.upsertSemanticMemory("source", {
      subject: "Ada",
      content: "Ada uses SQLite.",
    });
    const jsonl = await source.exportProjectJsonl("source");
    const destination = await store();
    await destination.upsertSemanticMemory("copy", {
      subject: "Existing",
      content: "Existing data.",
    });
    await expect(destination.importProjectJsonl(jsonl, "copy")).rejects.toThrow(
      "project already contains hybrid memory data"
    );
  });
});
