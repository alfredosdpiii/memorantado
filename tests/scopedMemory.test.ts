import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryStore } from "../src/db/store.js";
import { createTestStore, type TestStore } from "./helpers.js";

const SESSION_A = "ultron:session:a";
const SESSION_B = "ultron:session:b";
const PROJECT = "ultron:project:p1";
const GLOBAL = "ultron:global:me";

const databases: TestStore[] = [];

async function store(): Promise<MemoryStore> {
  const testStore = await createTestStore();
  databases.push(testStore);
  return testStore.store;
}

afterEach(async () => {
  while (databases.length) await databases.pop()!.cleanup();
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("scoped memory", () => {
  it("keeps tags and metadata on memories and episodes and recalls by scope", async () => {
    const db = await store();
    const own = await db.upsertSemanticMemory("u", {
      subject: "build",
      content: "The build runs with cargo nextest.",
      tags: [SESSION_A, SESSION_A],
      metadata: { ultron_evidence_class: "tool_evidence" },
    });
    await db.upsertSemanticMemory("u", {
      subject: "build",
      content: "The build runs with make in the other session.",
      tags: [SESSION_B],
    });
    const shared = await db.upsertSemanticMemory("u", {
      subject: "build",
      content: "The project build uses a pinned toolchain.",
      tags: [PROJECT],
    });
    await db.upsertSemanticMemory("u", {
      subject: "build",
      content: "Untagged build note.",
    });
    await db.appendEpisode("u", {
      content: "Session A talked about the build.",
      tags: [SESSION_A],
    });
    await db.appendEpisode("u", {
      content: "Session B talked about the build.",
      tags: [SESSION_B],
    });
    await db.createEntities("u", [{ name: "build", entityType: "concept" }]);

    expect(own.tags).toEqual([SESSION_A]);
    expect(own.metadata).toEqual({ ultron_evidence_class: "tool_evidence" });

    const exact = await db.retrieveContext("u", "build", {
      tags: { tags: [SESSION_A], match: "exact" },
    });
    expect(exact.memories.map((hit) => hit.memory?.id)).toEqual([own.id]);
    expect(exact.memories[0].memory).toMatchObject({
      tags: [SESSION_A],
      metadata: { ultron_evidence_class: "tool_evidence" },
    });
    expect(exact.episodes.map((hit) => hit.episode?.tags)).toEqual([[SESSION_A]]);
    expect(exact.graph.entities).toEqual([]);

    const recall = await db.retrieveContext("u", "build", {
      tags: { tags: [GLOBAL, PROJECT, SESSION_A], match: "any" },
    });
    expect(recall.memories.map((hit) => hit.memory?.id).sort()).toEqual(
      [own.id, shared.id].sort()
    );

    const unscoped = await db.retrieveContext("u", "build");
    expect(unscoped.memories).toHaveLength(4);
    expect(unscoped.graph.entities).toHaveLength(1);

    const episodes = await db.listEpisodes("u", {
      tags: { tags: [SESSION_B], match: "all" },
    });
    expect(episodes.map((episode) => episode.content)).toEqual([
      "Session B talked about the build.",
    ]);
  });

  it("scopes temporal recall through the memory's tags", async () => {
    const db = await store();
    await db.upsertSemanticMemory("u", {
      subject: "Ada",
      content: "Ada used SQLite in 2024.",
      validFrom: "2024-01-01T00:00:00.000Z",
      tags: [SESSION_A],
    });
    await db.upsertSemanticMemory("u", {
      subject: "Ada",
      content: "Ada used Postgres in 2024.",
      validFrom: "2024-01-01T00:00:00.000Z",
      tags: [SESSION_B],
    });
    const pack = await db.retrieveContext("u", "Ada used 2024", {
      mode: "history",
      tags: { tags: [SESSION_A], match: "exact" },
    });
    expect(pack.memories.map((hit) => hit.version?.content)).toEqual([
      "Ada used SQLite in 2024.",
    ]);
  });

  it("reinforces and flags conflicts only within the same tags", async () => {
    const db = await store();
    const claim = {
      kind: "preference",
      subject: "Ada",
      predicate: "prefers",
      object: "SQLite",
      content: "Ada prefers SQLite.",
    };
    const a = await db.upsertSemanticMemory("u", { ...claim, tags: [SESSION_A] });
    const b = await db.upsertSemanticMemory("u", { ...claim, tags: [SESSION_B] });
    const again = await db.upsertSemanticMemory("u", { ...claim, tags: [SESSION_A] });
    expect(b.id).not.toBe(a.id);
    expect(again.id).toBe(a.id);
    expect(again.confidence).toBeGreaterThan(a.confidence);

    await db.upsertSemanticMemory("u", {
      ...claim,
      object: "Postgres",
      content: "Ada prefers Postgres.",
      tags: [SESSION_B],
    });
    const conflicts = await db.listConflicts("u");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflictingId).toBe(b.id);
  });

  it("follows a key across supersessions", async () => {
    const db = await store();
    const first = await db.upsertSemanticMemory("u", {
      subject: "launcher",
      content: "The launcher lives in bin/pi.",
      key: "doc-1",
      tags: [PROJECT],
      metadata: { ultron_operation: "op-1" },
    });
    const same = await db.upsertSemanticMemory("u", {
      subject: "launcher",
      content: "The launcher lives in bin/pi.",
      key: "doc-1",
    });
    expect(same.id).toBe(first.id);

    const replaced = await db.upsertSemanticMemory("u", {
      subject: "launcher",
      content: "The launcher lives in bin/ultron.",
      key: "doc-1",
      metadata: { ultron_operation: "op-2" },
    });
    expect(replaced).toMatchObject({
      key: "doc-1",
      tags: [PROJECT],
      supersedesId: first.id,
      status: "active",
      metadata: { ultron_operation: "op-2" },
    });
    expect(await db.getSemanticMemoryByKey("u", "doc-1")).toMatchObject({
      id: replaced.id,
    });
    expect(await db.getSemanticMemory("u", first.id)).toMatchObject({
      status: "superseded",
      key: null,
    });
    const pack = await db.retrieveContext("u", "launcher lives", {
      tags: { tags: [PROJECT], match: "exact" },
    });
    expect(pack.memories.map((hit) => hit.id)).toEqual([replaced.id]);
    const history = await db.explainMemory("u", replaced.id);
    expect(history.versions[0].supersedesVersionId).not.toBeNull();
  });

  it("supersedes, confirms, invalidates and forgets memories", async () => {
    const db = await store();
    const memory = await db.upsertSemanticMemory("u", {
      kind: "procedure",
      subject: "tests",
      content: "Run tests with npm test.",
      tags: [PROJECT],
    });
    const next = await db.supersedeMemory("u", memory.id, {
      content: "Run tests with npm run validate.",
    });
    expect(next).toMatchObject({
      kind: "procedure",
      subject: "tests",
      tags: [PROJECT],
      supersedesId: memory.id,
    });
    await expect(
      db.supersedeMemory("u", memory.id, { content: "Again." })
    ).rejects.toThrow(`memory ${memory.id} is superseded`);
    expect(await db.supersedeMemory("u", 999_999, { content: "Missing." })).toBeNull();

    const before = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const other = await db.upsertSemanticMemory("u", {
      subject: "lint",
      content: "Lint with eslint.",
      tags: [PROJECT],
    });
    expect(
      (
        await db.listSemanticMemories("u", { status: "active", confirmedBefore: before })
      ).map((item) => item.id)
    ).toEqual([next!.id]);
    const confirmed = await db.confirmMemory("u", next!.id);
    expect(confirmed!.lastConfirmedAt! > before).toBe(true);
    expect(
      (
        await db.listSemanticMemories("u", { status: "active", confirmedBefore: before })
      ).map((item) => item.id)
    ).toEqual([]);
    expect(
      (
        await db.listSemanticMemories("u", {
          status: "active",
          sort: "confirmed",
          tags: { tags: [PROJECT], match: "exact" },
        })
      ).map((item) => item.id)
    ).toEqual([other.id, next!.id]);

    const invalid = await db.invalidateMemory("u", other.id, "eslint was replaced");
    expect(invalid).toMatchObject({
      status: "invalidated",
      metadata: { invalidation: { reason: "eslint was replaced" } },
    });
    const lint = await db.retrieveContext("u", "Lint with eslint");
    expect(lint.memories.map((hit) => hit.id)).not.toContain(other.id);

    expect(await db.deleteSemanticMemory("u", next!.id)).toBe(true);
    expect(await db.getSemanticMemory("u", memory.id)).toBeNull();
    expect(await db.getSemanticMemory("u", other.id)).not.toBeNull();
    expect(await db.deleteSemanticMemory("u", next!.id)).toBe(false);
    expect(await db.getSemanticMemory("u", next!.id)).toBeNull();
    expect(await db.confirmMemory("u", next!.id)).toBeNull();
    expect(await db.invalidateMemory("u", next!.id)).toBeNull();
  });

  it("flags a conflict between two memories once", async () => {
    const db = await store();
    const left = await db.upsertSemanticMemory("u", { subject: "x", content: "X is 1." });
    const right = await db.upsertSemanticMemory("u", {
      subject: "x",
      content: "X is 2.",
    });
    const conflict = await db.createConflict(
      "u",
      left.id,
      right.id,
      "dreaming: disagree"
    );
    expect(conflict).toMatchObject({
      memoryId: left.id,
      conflictingId: right.id,
      reason: "dreaming: disagree",
      resolutionStatus: "open",
    });
    expect(await db.createConflict("u", right.id, left.id, "again")).toMatchObject({
      id: conflict!.id,
    });
    expect(await db.createConflict("u", left.id, left.id, "self")).toBeNull();
    expect(await db.createConflict("other", left.id, right.id, "elsewhere")).toBeNull();
  });

  it("keeps file evidence by content hash and reports stale memories", async () => {
    const db = await store();
    const v1 = 'fn main() {\n    run_launcher("bin/pi");\n}\n';
    const v2 = 'fn main() {\n    run_launcher("bin/ultron");\n}\n';
    const first = await db.recordFileSnapshot("u", {
      source: "repo://src/main.rs",
      content: v1,
      tags: [PROJECT],
    });
    expect(first).toMatchObject({
      created: true,
      snapshot: { source: "repo://src/main.rs", contentHash: sha256(v1) },
      episode: { role: "file", source: "repo://src/main.rs", tags: [PROJECT] },
    });
    const repeat = await db.recordFileSnapshot("u", {
      source: "repo://src/main.rs",
      content: v1,
    });
    expect(repeat).toMatchObject({
      created: false,
      snapshot: { episodeId: first.snapshot.episodeId },
    });
    await expect(
      db.recordFileSnapshot("u", { source: "/etc/passwd", content: "x" })
    ).rejects.toThrow("source must be repo://<path>");

    const memory = await db.upsertSemanticMemory(
      "u",
      { subject: "launcher", content: "main runs bin/pi.", tags: [PROJECT] },
      first.snapshot.episodeId,
      { quote: 'run_launcher("bin/pi")' }
    );
    const explained = await db.explainMemory("u", memory.id);
    expect(explained.evidence[0]).toMatchObject({
      episodeId: first.snapshot.episodeId,
      quote: 'run_launcher("bin/pi")',
      source: "repo://src/main.rs",
      spanStart: v1.indexOf("run_launcher"),
    });

    const current = [{ source: "repo://src/main.rs", contentHash: sha256(v1) }];
    expect(await db.findStaleFileEvidence("u", current)).toEqual([]);
    const changed = [{ source: "repo://src/main.rs", contentHash: sha256(v2) }];
    expect(await db.findStaleFileEvidence("u", changed)).toEqual([
      {
        memoryId: memory.id,
        source: "repo://src/main.rs",
        currentHash: sha256(v2),
        evidenceHashes: [sha256(v1)],
      },
    ]);

    const second = await db.recordFileSnapshot("u", {
      source: "repo://src/main.rs",
      content: v2,
    });
    await db.confirmMemory("u", memory.id, {
      sourceEpisodeId: second.snapshot.episodeId,
      quote: 'run_launcher("bin/ultron")',
    });
    expect(await db.findStaleFileEvidence("u", changed)).toEqual([]);
  });

  it("round-trips tags, keys and file snapshots through JSONL", async () => {
    const source = await store();
    const snapshot = await source.recordFileSnapshot("src", {
      source: "repo://README.md",
      content: "# Ultron",
      tags: [PROJECT],
    });
    const memory = await source.upsertSemanticMemory(
      "src",
      {
        subject: "readme",
        content: "The README title is Ultron.",
        key: "k1",
        tags: [PROJECT],
      },
      snapshot.snapshot.episodeId
    );
    const jsonl = await source.exportProjectJsonl("src");
    const destination = await store();
    const result = await destination.importProjectJsonl(jsonl, "copy");
    expect(result.imported).toMatchObject({
      memory_tags: 1,
      episode_tags: 1,
      memory_keys: 1,
      file_snapshots: 1,
    });
    expect(await destination.getSemanticMemoryByKey("copy", "k1")).toMatchObject({
      id: memory.id,
      tags: [PROJECT],
    });
    expect(
      await destination.findStaleFileEvidence("copy", [
        { source: "repo://README.md", contentHash: sha256("# Ultron 2") },
      ])
    ).toHaveLength(1);
  });
});
