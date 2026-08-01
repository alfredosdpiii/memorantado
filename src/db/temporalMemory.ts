import type Database from "better-sqlite3";
import { contentHash } from "../memory/localEmbedding.js";
import { upsertLocalEmbedding } from "./embeddingStore.js";
import type {
  CandidateMemory,
  ClaimVersion,
  ConflictResolutionEvent,
  Episode,
  MemoryConflict,
  MemoryEvidence,
  SemanticMemory,
} from "../memory/types.js";
import {
  mapClaimVersion,
  mapConflict,
  mapMemoryEvidence,
  mapResolutionEvent,
  type ClaimVersionRow,
  type ConflictResolutionEventRow,
  type EpisodeRow,
  type MemoryConflictRow,
  type MemoryEvidenceRow,
} from "./hybridRows.js";

export type MemoryExplanation = {
  memory: SemanticMemory | null;
  versions: ClaimVersion[];
  evidence: MemoryEvidence[];
  sources: Episode[];
  conflicts: MemoryConflict[];
  resolutionEvents: ConflictResolutionEvent[];
};

export function insertClaimVersion(
  db: Database.Database,
  memory: SemanticMemory,
  input: CandidateMemory,
  supersedesVersionId?: number
): ClaimVersion {
  const metadata = input.metadata ?? memory.metadata;
  const extractorId =
    typeof metadata?.extractor === "string" ? metadata.extractor : "manual";
  const row = db
    .prepare(
      `INSERT INTO claim_versions (
         memory_id, project, scope, kind, subject, predicate, object, content,
         confidence, importance, status, valid_from, valid_to,
         supersedes_version_id, metadata_json, extractor_id, extractor_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      memory.id,
      memory.project,
      memory.scope,
      memory.kind,
      memory.subject,
      memory.predicate,
      memory.object,
      memory.content,
      memory.confidence,
      memory.importance,
      memory.status,
      input.validFrom ?? memory.validFrom,
      input.validTo ?? memory.validTo,
      supersedesVersionId ?? null,
      metadata ? JSON.stringify(metadata) : null,
      extractorId,
      "1"
    ) as ClaimVersionRow;
  if (supersedesVersionId) {
    db.prepare(
      `UPDATE claim_versions
       SET status = 'superseded', retracted_at = ?
       WHERE id = ? AND retracted_at IS NULL`
    ).run(row.recorded_at, supersedesVersionId);
  }
  // Embed once at write time (deterministic local hash) so retrieval never
  // re-embeds historical content per query. Identical vectors as before.
  upsertLocalEmbedding(db, "claim_version", row.id, row.content);
  return mapClaimVersion(row);
}

export function latestClaimVersionId(
  db: Database.Database,
  memoryId: number
): number | undefined {
  const row = db
    .prepare(
      `SELECT id FROM claim_versions
       WHERE memory_id = ?
       ORDER BY recorded_at DESC, id DESC
       LIMIT 1`
    )
    .get(memoryId) as { id: number } | undefined;
  return row?.id;
}

export function insertMemoryEvidence(
  db: Database.Database,
  version: ClaimVersion,
  episodeId: number,
  quote: string,
  spanStart?: number
): void {
  const episode = db
    .prepare(
      `SELECT id, project, session, actor, role, content, source, metadata_json, created_at
       FROM episodes WHERE id = ?`
    )
    .get(episodeId) as EpisodeRow | undefined;
  if (!episode) return;
  const start = spanStart ?? episode.content.indexOf(quote);
  db.prepare(
    `INSERT OR IGNORE INTO memory_evidence (
       claim_version_id, episode_id, quote, span_start, span_end, content_hash,
       polarity, actor, source, observed_at, ingested_at, extractor_id,
       extractor_version
     ) VALUES (?, ?, ?, ?, ?, ?, 'supports', ?, ?, ?, ?, ?, ?)`
  ).run(
    version.id,
    episode.id,
    quote,
    start >= 0 ? start : null,
    start >= 0 ? start + quote.length : null,
    contentHash(quote),
    episode.actor,
    episode.source,
    observedAt(episode),
    episode.created_at,
    version.extractorId,
    version.extractorVersion
  );
}

export function explainMemoryHistory(
  db: Database.Database,
  project: string,
  memory: SemanticMemory | null,
  sources: Episode[]
): MemoryExplanation {
  if (!memory) {
    return {
      memory: null,
      versions: [],
      evidence: [],
      sources: [],
      conflicts: [],
      resolutionEvents: [],
    };
  }
  const conflicts = (
    db
      .prepare(
        `SELECT * FROM memory_conflicts
         WHERE project = ? AND (memory_id = ? OR conflicting_id = ?)
         ORDER BY created_at DESC`
      )
      .all(project, memory.id, memory.id) as MemoryConflictRow[]
  ).map(mapConflict);
  const conflictIds = conflicts.map((conflict) => conflict.id);
  const resolutionEvents = conflictIds.length
    ? (
        db
          .prepare(
            `SELECT * FROM conflict_resolution_events
             WHERE project = ? AND conflict_id IN (${conflictIds.map(() => "?").join(",")})
             ORDER BY created_at DESC, id DESC`
          )
          .all(project, ...conflictIds) as ConflictResolutionEventRow[]
      ).map(mapResolutionEvent)
    : [];
  const versions = (
    db
      .prepare(
        `SELECT * FROM claim_versions
         WHERE project = ? AND memory_id = ?
         ORDER BY recorded_at DESC, id DESC`
      )
      .all(project, memory.id) as ClaimVersionRow[]
  ).map(mapClaimVersion);
  const evidence = (
    db
      .prepare(
        `SELECT me.*
         FROM memory_evidence me
         JOIN claim_versions cv ON cv.id = me.claim_version_id
         WHERE cv.project = ? AND cv.memory_id = ?
         ORDER BY me.created_at DESC, me.id DESC`
      )
      .all(project, memory.id) as MemoryEvidenceRow[]
  ).map(mapMemoryEvidence);
  return { memory, versions, evidence, sources, conflicts, resolutionEvents };
}

function observedAt(episode: EpisodeRow): string {
  if (episode.metadata_json) {
    const metadata = JSON.parse(episode.metadata_json) as Record<string, unknown>;
    for (const key of ["observedAt", "date", "createdAt"]) {
      const value = metadata[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return episode.created_at;
}
