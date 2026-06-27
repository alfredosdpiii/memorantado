import { afterEach, describe, expect, it } from "vitest";
import * as graph from "../src/db/graph.js";
import * as timeline from "../src/db/timeline.js";
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

describe("graph storage", () => {
  it("creates entities, observations, and relations", () => {
    const database = db();

    const entities = graph.createEntities(database, "test", [
      {
        name: "Ada",
        entityType: "person",
        observations: ["Built a memory graph"],
      },
      {
        name: "Memorantado",
        entityType: "project",
        observations: ["Stores durable context"],
      },
    ]);
    graph.createRelations(database, "test", [
      { from: "Ada", to: "Memorantado", relationType: "uses" },
    ]);

    expect(entities).toHaveLength(2);
    expect(graph.readGraph(database, "test")).toEqual({
      entities: [
        {
          name: "Ada",
          entityType: "person",
          observations: ["Built a memory graph"],
        },
        {
          name: "Memorantado",
          entityType: "project",
          observations: ["Stores durable context"],
        },
      ],
      relations: [{ from: "Ada", to: "Memorantado", relationType: "uses" }],
    });
  });

  it("searches matching entities and observations", () => {
    const database = db();
    graph.createEntities(database, "test", [
      { name: "Ada", entityType: "person", observations: ["Prefers SQLite"] },
    ]);

    const result = graph.searchNodes(database, "test", "sqlite");

    expect(result.entities).toEqual([
      {
        name: "Ada",
        entityType: "person",
        observations: ["Prefers SQLite"],
      },
    ]);
  });
});

describe("memory timeline", () => {
  it("appends, searches, reads, and deletes memory items", () => {
    const database = db();
    const item = timeline.appendMemoryItem(database, "test", {
      kind: "decision",
      title: "Use SQLite",
      content: "Keep local storage simple",
      tags: ["storage"],
      source: "test",
    });

    expect(timeline.searchMemoryItems(database, "test", "storage simple")).toHaveLength(
      1
    );
    expect(timeline.getMemoryItem(database, "test", item.id)?.tags).toEqual(["storage"]);
    expect(timeline.deleteMemoryItem(database, "test", item.id)).toBe(true);
    expect(timeline.getMemoryItem(database, "test", item.id)).toBeNull();
  });
});
