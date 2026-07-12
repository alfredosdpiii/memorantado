import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as graph from "../src/db/graph.js";
import * as hybrid from "../src/db/hybridMemory.js";
import * as wiki from "../src/wiki/obsidian.js";
import { createTestDb, type TestDb } from "./helpers.js";

let current: TestDb | undefined;
let vault: string | undefined;

afterEach(() => {
  current?.cleanup();
  current = undefined;
  if (vault) fs.rmSync(vault, { force: true, recursive: true });
  vault = undefined;
});

describe("Obsidian projection", () => {
  it("rebuilds a generated folder and removes stale generated files", async () => {
    current = createTestDb();
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "memorantado-vault-"));
    graph.createEntities(current.db, "wiki", [
      { name: "Ada Lovelace", entityType: "person", observations: ["Prefers SQLite"] },
    ]);
    const episode = hybrid.appendEpisode(current.db, "wiki", {
      actor: "Ada",
      content: "Ada prefers SQLite.",
      source: "test",
    });
    const [memory] = await hybrid.extractMemories(current.db, "wiki", episode.id);

    const first = wiki.buildObsidianWiki(current.db, "wiki", vault);
    const root = path.join(vault, "Memorantado Generated");
    expect(first.files).toContain(`Memories/memory-${memory.id}.md`);
    expect(
      fs.readFileSync(path.join(root, `Memories/memory-${memory.id}.md`), "utf8")
    ).toContain(`[[Sources/episode-${episode.id}|episode ${episode.id}]]`);
    expect(fs.existsSync(path.join(root, "Memories.base"))).toBe(true);

    fs.writeFileSync(path.join(root, "stale.md"), "stale");
    const second = wiki.buildObsidianWiki(current.db, "wiki", vault);
    expect(second.revision).toBe(first.revision);
    expect(fs.existsSync(path.join(root, "stale.md"))).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, ".memorantado-manifest.json"), "utf8"))
    ).toMatchObject({
      format: "memorantado-obsidian",
      project: "wiki",
      revision: first.revision,
    });
    const state = current.db
      .prepare("SELECT count(*) AS count FROM wiki_projection_state WHERE project = ?")
      .get("wiki") as { count: number };
    expect(state.count).toBe(first.files.length);
  });
});
