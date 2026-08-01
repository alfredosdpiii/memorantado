import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as wiki from "../src/wiki/obsidian.js";
import { createTestStore, type TestStore } from "./helpers.js";

let current: TestStore | undefined;
let vault: string | undefined;

afterEach(async () => {
  await current?.cleanup();
  current = undefined;
  if (vault) fs.rmSync(vault, { force: true, recursive: true });
  vault = undefined;
});

describe("Obsidian projection", () => {
  it("rebuilds a generated folder and removes stale generated files", async () => {
    current = await createTestStore();
    const store = current.store;
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "memorantado-vault-"));
    await store.createEntities("wiki", [
      { name: "Ada Lovelace", entityType: "person", observations: ["Prefers SQLite"] },
    ]);
    const episode = await store.appendEpisode("wiki", {
      actor: "Ada",
      content: "Ada prefers SQLite.",
      source: "test",
    });
    const [memory] = await store.extractMemories("wiki", episode.id);

    const first = await wiki.buildObsidianWiki(store, "wiki", vault);
    const root = path.join(vault, "Memorantado Generated");
    expect(first.files).toContain(`Memories/memory-${memory.id}.md`);
    expect(
      fs.readFileSync(path.join(root, `Memories/memory-${memory.id}.md`), "utf8")
    ).toContain(`[[Sources/episode-${episode.id}|episode ${episode.id}]]`);
    expect(fs.existsSync(path.join(root, "Memories.base"))).toBe(true);

    fs.writeFileSync(path.join(root, "stale.md"), "stale");
    const second = await wiki.buildObsidianWiki(store, "wiki", vault);
    expect(second.revision).toBe(first.revision);
    expect(fs.existsSync(path.join(root, "stale.md"))).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, ".memorantado-manifest.json"), "utf8"))
    ).toMatchObject({
      format: "memorantado-obsidian",
      project: "wiki",
      revision: first.revision,
    });
    expect(await store.wikiProjectionStateCount("wiki")).toBe(first.files.length);
  });
});
