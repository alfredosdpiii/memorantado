import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { STORE_KIND } from "./helpers.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) fs.rmSync(dir, { force: true, recursive: true });
  dir = undefined;
});

// These tests exercise sqlite-specific migration internals (schema_migrations
// bookkeeping and legacy backfill repairs). The pg backend starts at the
// current schema, so the suite is sqlite-only.
describe.skipIf(STORE_KIND === "pg")("database migrations", () => {
  it("ignores legacy generic false conflicts and preserves structured conflicts", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorantado-migration-"));
    const db = new Database(path.join(dir, "test.sqlite"));
    db.pragma("foreign_keys = ON");
    migrate(db);
    db.prepare("DELETE FROM schema_migrations WHERE version = 2").run();

    const insertMemory = db.prepare(
      `INSERT INTO semantic_memories (
         project, scope, kind, subject, predicate, object, content
       ) VALUES ('migration', 'project', ?, ?, ?, ?, ?) RETURNING id`
    );
    const noteA = insertMemory.get("note", "assistant", "states", null, "First note") as {
      id: number;
    };
    const noteB = insertMemory.get(
      "note",
      "assistant",
      "states",
      null,
      "Second note"
    ) as {
      id: number;
    };
    const east = insertMemory.get("fact", "deploy", "region", "east", "Region east") as {
      id: number;
    };
    const west = insertMemory.get("fact", "deploy", "region", "west", "Region west") as {
      id: number;
    };
    const insertConflict = db.prepare(
      `INSERT INTO memory_conflicts (project, memory_id, conflicting_id, reason)
       VALUES ('migration', ?, ?, 'legacy') RETURNING id`
    );
    const falseConflict = insertConflict.get(noteB.id, noteA.id) as { id: number };
    const realConflict = insertConflict.get(west.id, east.id) as { id: number };

    migrate(db);

    expect(
      db
        .prepare("SELECT resolution_status FROM memory_conflicts WHERE id = ?")
        .get(falseConflict.id)
    ).toEqual({ resolution_status: "ignored" });
    expect(
      db
        .prepare("SELECT resolution_status FROM memory_conflicts WHERE id = ?")
        .get(realConflict.id)
    ).toEqual({ resolution_status: "open" });
    expect(
      db
        .prepare(
          "SELECT actor, reason FROM conflict_resolution_events WHERE conflict_id = ?"
        )
        .get(falseConflict.id)
    ).toEqual({ actor: "migration", reason: "legacy_false_positive" });
    db.close();
  });

  it("backfills active lifecycle rows for existing memories", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorantado-lifecycle-migration-"));
    const db = new Database(path.join(dir, "test.sqlite"));
    db.pragma("foreign_keys = ON");
    migrate(db);
    const memory = db
      .prepare(
        `INSERT INTO semantic_memories (project, subject, predicate, content)
         VALUES ('migration', 'Ada', 'uses', 'Ada uses SQLite.') RETURNING id`
      )
      .get() as { id: number };
    db.prepare("DELETE FROM memory_lifecycle WHERE memory_id = ?").run(memory.id);
    db.prepare("DELETE FROM schema_migrations WHERE version = 3").run();

    migrate(db);

    expect(
      db.prepare("SELECT status FROM memory_lifecycle WHERE memory_id = ?").get(memory.id)
    ).toEqual({ status: "active" });
    db.close();
  });
});
