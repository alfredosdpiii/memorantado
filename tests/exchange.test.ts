import { afterEach, describe, expect, it } from "vitest";
import * as exchange from "../src/db/exchange.js";
import * as hybrid from "../src/db/hybridMemory.js";
import { createTestDb, type TestDb } from "./helpers.js";

const databases: TestDb[] = [];

function db() {
  const testDb = createTestDb();
  databases.push(testDb);
  return testDb.db;
}

afterEach(() => {
  while (databases.length) databases.pop()!.cleanup();
});

describe("JSONL exchange", () => {
  it("round-trips hybrid memory without losing IDs, evidence, or audit", async () => {
    const source = db();
    const episode = hybrid.appendEpisode(source, "source", {
      actor: "Ada",
      content: "Ada prefers SQLite.",
      source: "test",
      metadata: { observedAt: "2025-01-01T00:00:00.000Z" },
    });
    const first = hybrid.upsertSemanticMemory(
      source,
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
    const competing = hybrid.upsertSemanticMemory(source, "source", {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "Postgres",
      content: "Ada prefers Postgres.",
    });
    const conflict = hybrid.listConflicts(source, "source")[0];
    hybrid.resolveConflict(source, "source", conflict.id, competing.id, "resolved", {
      actor: "reviewer",
      reason: "verified",
    });

    const jsonl = exchange.exportProjectJsonl(source, "source");
    const destination = db();
    exchange.importProjectJsonl(destination, jsonl, "copy");

    const copied = hybrid.explainMemory(destination, "copy", first.id);
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
      (await hybrid.retrieveContext(destination, "copy", "What does Ada prefer?")).context
    ).toContain("Ada prefers");
  });

  it("refuses to merge into a non-empty project", () => {
    const source = db();
    hybrid.upsertSemanticMemory(source, "source", {
      subject: "Ada",
      content: "Ada uses SQLite.",
    });
    const jsonl = exchange.exportProjectJsonl(source, "source");
    const destination = db();
    hybrid.upsertSemanticMemory(destination, "copy", {
      subject: "Existing",
      content: "Existing data.",
    });
    expect(() => exchange.importProjectJsonl(destination, jsonl, "copy")).toThrow(
      "project already contains hybrid memory data"
    );
  });
});
