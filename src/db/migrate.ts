import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { semanticConflictReason } from "../memory/conflicts.js";
import { contentHash, embedText, embeddingDimension } from "../memory/localEmbedding.js";
import { mapMemory, type SemanticMemoryRow } from "./hybridRows.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Migration = {
  version: number;
  name: string;
  run(db: Database.Database): void;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "temporal-memory-foundation",
    run(db) {
      backfillClaimVersions(db);
      backfillMemoryEvidence(db);
    },
  },
  {
    version: 2,
    name: "repair-legacy-false-conflicts",
    run(db) {
      repairLegacyConflicts(db);
    },
  },
  {
    version: 3,
    name: "semantic-memory-lifecycle",
    run(db) {
      backfillMemoryLifecycle(db);
    },
  },
  {
    version: 4,
    name: "claim-version-embeddings",
    run(db) {
      backfillClaimVersionEmbeddings(db);
    },
  },
];

function backfillClaimVersionEmbeddings(db: Database.Database): void {
  // Claim versions are embedded once at write time going forward; backfill the
  // deterministic local-hash vector for any pre-existing version so retrieval
  // never re-embeds historical content per query.
  const rows = db
    .prepare(
      `SELECT cv.id, cv.content
       FROM claim_versions cv
       LEFT JOIN claim_version_embeddings cve ON cve.claim_version_id = cv.id
       WHERE cve.claim_version_id IS NULL
       ORDER BY cv.id`
    )
    .all() as Array<{ id: number; content: string }>;
  const insert = db.prepare(
    `INSERT INTO claim_version_embeddings (
       claim_version_id, provider, dimension, vector_json, content_hash
     ) VALUES (?, 'local-hash', ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      row.id,
      embeddingDimension(),
      JSON.stringify(embedText(row.content)),
      contentHash(row.content)
    );
  }
}
function repairLegacyConflicts(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT mc.id AS conflict_id, mc.project AS conflict_project,
              winner.*, loser.id AS loser_id, loser.project AS loser_project,
              loser.scope AS loser_scope, loser.kind AS loser_kind,
              loser.subject AS loser_subject, loser.predicate AS loser_predicate,
              loser.object AS loser_object, loser.content AS loser_content,
              loser.confidence AS loser_confidence, loser.importance AS loser_importance,
              loser.status AS loser_status, loser.valid_from AS loser_valid_from,
              loser.valid_to AS loser_valid_to,
              loser.last_confirmed_at AS loser_last_confirmed_at,
              loser.supersedes_id AS loser_supersedes_id,
              loser.metadata_json AS loser_metadata_json,
              loser.created_at AS loser_created_at, loser.updated_at AS loser_updated_at
       FROM memory_conflicts mc
       JOIN semantic_memories winner ON winner.id = mc.memory_id
       JOIN semantic_memories loser ON loser.id = mc.conflicting_id
       WHERE mc.resolution_status = 'open'`
    )
    .all() as Array<
    SemanticMemoryRow & {
      conflict_id: number;
      conflict_project: string;
      loser_id: number;
      loser_project: string;
      loser_scope: string;
      loser_kind: string;
      loser_subject: string;
      loser_predicate: string;
      loser_object: string | null;
      loser_content: string;
      loser_confidence: number;
      loser_importance: number;
      loser_status: "active" | "superseded" | "invalidated";
      loser_valid_from: string | null;
      loser_valid_to: string | null;
      loser_last_confirmed_at: string | null;
      loser_supersedes_id: number | null;
      loser_metadata_json: string | null;
      loser_created_at: string;
      loser_updated_at: string;
    }
  >;
  const ignore = db.prepare(
    `UPDATE memory_conflicts
     SET resolution_status = 'ignored', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  );
  const audit = db.prepare(
    `INSERT INTO conflict_resolution_events (conflict_id, project, action, actor, reason)
     VALUES (?, ?, 'ignored', 'migration', 'legacy_false_positive')`
  );
  for (const row of rows) {
    const winner = mapMemory(row);
    const loser = mapMemory({
      id: row.loser_id,
      project: row.loser_project,
      scope: row.loser_scope,
      kind: row.loser_kind,
      subject: row.loser_subject,
      predicate: row.loser_predicate,
      object: row.loser_object,
      content: row.loser_content,
      confidence: row.loser_confidence,
      importance: row.loser_importance,
      status: row.loser_status,
      valid_from: row.loser_valid_from,
      valid_to: row.loser_valid_to,
      last_confirmed_at: row.loser_last_confirmed_at,
      supersedes_id: row.loser_supersedes_id,
      metadata_json: row.loser_metadata_json,
      created_at: row.loser_created_at,
      updated_at: row.loser_updated_at,
    });
    if (
      semanticConflictReason(loser, {
        scope: winner.scope,
        kind: winner.kind,
        subject: winner.subject,
        predicate: winner.predicate,
        object: winner.object ?? undefined,
        content: winner.content,
        confidence: winner.confidence,
        importance: winner.importance,
        validFrom: winner.validFrom ?? undefined,
        validTo: winner.validTo ?? undefined,
        metadata: winner.metadata ?? undefined,
      })
    )
      continue;
    ignore.run(row.conflict_id);
    audit.run(row.conflict_id, row.conflict_project);
  }
}

function backfillMemoryLifecycle(db: Database.Database): void {
  db.exec(`
    INSERT OR IGNORE INTO memory_lifecycle (memory_id, status)
    SELECT id, 'active' FROM semantic_memories;
  `);
}

function backfillClaimVersions(db: Database.Database): void {
  db.exec(`
    INSERT INTO claim_versions (
      memory_id, project, scope, kind, subject, predicate, object, content,
      confidence, importance, status, valid_from, valid_to, recorded_at,
      retracted_at, metadata_json, extractor_id, extractor_version
    )
    SELECT
      sm.id, sm.project, sm.scope, sm.kind, sm.subject, sm.predicate, sm.object,
      sm.content, sm.confidence, sm.importance, sm.status, sm.valid_from,
      sm.valid_to, sm.created_at,
      CASE WHEN sm.status = 'active' THEN NULL ELSE sm.updated_at END,
      sm.metadata_json,
      COALESCE(json_extract(sm.metadata_json, '$.extractor'), 'legacy'),
      '1'
    FROM semantic_memories sm
    WHERE NOT EXISTS (
      SELECT 1 FROM claim_versions cv WHERE cv.memory_id = sm.id
    );
  `);
}

function backfillMemoryEvidence(db: Database.Database): void {
  db.exec(`
    INSERT OR IGNORE INTO memory_evidence (
      claim_version_id, episode_id, quote, span_start, span_end, content_hash,
      polarity, actor, source, observed_at, ingested_at, extractor_id,
      extractor_version
    )
    SELECT
      cv.id, e.id, COALESCE(ms.quote, cv.content),
      CASE
        WHEN instr(e.content, COALESCE(ms.quote, cv.content)) > 0
          THEN instr(e.content, COALESCE(ms.quote, cv.content)) - 1
        ELSE NULL
      END,
      CASE
        WHEN instr(e.content, COALESCE(ms.quote, cv.content)) > 0
          THEN instr(e.content, COALESCE(ms.quote, cv.content)) - 1
               + length(COALESCE(ms.quote, cv.content))
        ELSE NULL
      END,
      lower(hex(COALESCE(ms.quote, cv.content))),
      'supports', e.actor, e.source,
      COALESCE(json_extract(e.metadata_json, '$.observedAt'), e.created_at),
      e.created_at, cv.extractor_id, cv.extractor_version
    FROM memory_sources ms
    JOIN claim_versions cv ON cv.memory_id = ms.memory_id
    JOIN episodes e ON e.id = ms.episode_id;
  `);
}

export function migrate(db: Database.Database): void {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");

  db.exec(schema);
  db.transaction(() => {
    for (const migration of MIGRATIONS) {
      const exists = db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(migration.version);
      if (exists) continue;
      migration.run(db);
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
        migration.version,
        migration.name
      );
    }
  })();
}
