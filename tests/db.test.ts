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

describe("graph storage", () => {
  it("creates entities, observations, and relations", async () => {
    const database = await store();

    const entities = await database.createEntities("test", [
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
    await database.createRelations("test", [
      { from: "Ada", to: "Memorantado", relationType: "uses" },
    ]);

    expect(entities).toHaveLength(2);
    expect(await database.readGraph("test")).toEqual({
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

  it("searches matching entities and observations", async () => {
    const database = await store();
    await database.createEntities("test", [
      { name: "Ada", entityType: "person", observations: ["Prefers SQLite"] },
    ]);

    const result = await database.searchNodes("test", "sqlite");

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
  it("appends, searches, reads, and deletes memory items", async () => {
    const database = await store();
    const item = await database.appendMemoryItem("test", {
      kind: "decision",
      title: "Use SQLite",
      content: "Keep local storage simple",
      tags: ["storage"],
      source: "test",
    });

    expect(await database.searchMemoryItems("test", "storage simple")).toHaveLength(1);
    expect((await database.getMemoryItem("test", item.id))?.tags).toEqual(["storage"]);
    expect(await database.deleteMemoryItem("test", item.id)).toBe(true);
    expect(await database.getMemoryItem("test", item.id)).toBeNull();
  });
});
