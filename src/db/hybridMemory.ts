import type Database from "better-sqlite3";
import { upsertLocalEmbedding } from "./embeddingStore.js";
import { createLocalExtractor } from "../memory/extractor.js";
import { semanticConflictReason } from "../memory/conflicts.js";
import type {
  CandidateMemory,
  ClaimVersion,
  Episode,
  EvidenceInput,
  SemanticMemory,
  TagFilter,
} from "../memory/types.js";
import {
  EPISODE_TAGS,
  MEMORY_TAGS,
  StateError,
  normalizeTags,
  tagPredicate,
} from "../memory/tags.js";
import { getMemorySources } from "./hybridRetrieval.js";
import { createConflict } from "./memoryConflicts.js";
import { sameClaim, successorClaim } from "./memoryRules.js";
import {
  episodeColumns,
  mapEpisode,
  mapMemory,
  MEMORY_WITH_LIFECYCLE_SELECT,
  normalizeScope,
  type EpisodeRow,
  type SemanticMemoryRow,
} from "./hybridRows.js";
import {
  explainMemoryHistory,
  insertClaimVersion,
  insertMemoryEvidence,
  latestClaimVersionId,
  type MemoryExplanation,
} from "./temporalMemory.js";

export { retrieveContext } from "./hybridRetrieval.js";

export type AppendEpisodeInput = {
  session?: string;
  actor?: string;
  role?: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
};

const EPISODE_COLUMNS = episodeColumns("sqlite", "episodes");

export function appendEpisode(
  db: Database.Database,
  project: string,
  input: AppendEpisodeInput
): Episode {
  const tags = normalizeTags(input.tags);
  const episode = db.transaction(() => {
    const inserted = insertEpisode(db, project, input);
    const insertTag = db.prepare(
      "INSERT INTO episode_tags (episode_id, tag) VALUES (?, ?)"
    );
    for (const tag of tags) insertTag.run(inserted.id, tag);
    return { ...inserted, tags };
  })();
  upsertEpisodeEmbedding(db, episode);
  return episode;
}

function insertEpisode(
  db: Database.Database,
  project: string,
  input: AppendEpisodeInput
): Episode {
  const row = db
    .prepare(
      `INSERT INTO episodes (project, session, actor, role, content, source, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id, project, session, actor, role, content, source, metadata_json, created_at`
    )
    .get(
      project,
      input.session ?? null,
      input.actor ?? null,
      input.role ?? "user",
      input.content,
      input.source ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ) as EpisodeRow;
  return mapEpisode(row);
}

export function getEpisode(
  db: Database.Database,
  project: string,
  id: number
): Episode | null {
  const row = db
    .prepare(`SELECT ${EPISODE_COLUMNS} FROM episodes WHERE project = ? AND id = ?`)
    .get(project, id) as EpisodeRow | undefined;
  return row ? mapEpisode(row) : null;
}

export function listEpisodes(
  db: Database.Database,
  project: string,
  opts: { limit?: number; offset?: number; session?: string; tags?: TagFilter } = {}
): Episode[] {
  const params: Array<string | number> = [project];
  const bind = (value: string | number) => {
    params.push(value);
    return "?";
  };
  const clauses = ["project = ?"];
  if (opts.session) clauses.push(`session = ${bind(opts.session)}`);
  if (opts.tags) clauses.push(tagPredicate(EPISODE_TAGS, "episodes.id", opts.tags, bind));
  params.push(opts.limit ?? 50, opts.offset ?? 0);
  return (
    db
      .prepare(
        `SELECT ${EPISODE_COLUMNS} FROM episodes
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params) as EpisodeRow[]
  ).map(mapEpisode);
}

/**
 * Stores a claim. An equivalent active claim with the same tags is
 * reinforced. With a `key`, the key's current active memory is reinforced
 * when the claim is unchanged and superseded otherwise; a new key starts a
 * new memory. A differing exclusive claim with the same tags opens a conflict.
 */
export function upsertSemanticMemory(
  db: Database.Database,
  project: string,
  input: CandidateMemory,
  sourceEpisodeId?: number,
  evidence?: { quote?: string; spanStart?: number }
): SemanticMemory {
  const tags = normalizeTags(input.tags);
  const source = sourceEpisodeId ? { sourceEpisodeId, ...evidence } : undefined;
  const memoryId = db.transaction(() => {
    const keyed = input.key ? getMemoryByKey(db, project, input.key) : null;
    if (keyed?.status === "active") {
      return sameClaim(keyed, input)
        ? reinforceMemory(db, keyed, input, source).id
        : supersedeWithin(db, keyed, input, source).id;
    }
    const existing = input.key ? null : findActiveEquivalent(db, project, input, tags);
    if (existing) return reinforceMemory(db, existing, input, source).id;
    const conflicting = findConflictingMemory(db, project, input, tags);
    const inserted = insertTaggedMemory(db, project, input, tags, source);
    if (conflicting) {
      createConflict(db, project, inserted.id, conflicting.memory.id, conflicting.reason);
    }
    return inserted.id;
  })();
  return getMemory(db, project, memoryId) as SemanticMemory;
}

/**
 * Replaces the active memory `memoryId` with a new claim: the new memory
 * supersedes it, inherits its tags, key, kind, scope and subject unless the
 * input names them, and the old memory and its claim versions are retired.
 * Null when the memory does not exist; throws when it is not active.
 */
export function supersedeMemory(
  db: Database.Database,
  project: string,
  memoryId: number,
  input: Partial<CandidateMemory> & { content: string },
  evidence?: EvidenceInput
): SemanticMemory | null {
  const id = db.transaction(() => {
    const old = getMemory(db, project, memoryId);
    if (!old) return null;
    return supersedeWithin(db, old, input, evidence).id;
  })();
  return id === null ? null : getMemory(db, project, id);
}

function supersedeWithin(
  db: Database.Database,
  old: SemanticMemory,
  input: Partial<CandidateMemory> & { content: string },
  evidence?: EvidenceInput
): SemanticMemory {
  if (old.status !== "active") throw new StateError(`memory ${old.id} is ${old.status}`);
  const timestamp = new Date().toISOString();
  db.prepare(
    `UPDATE semantic_memories SET status = 'superseded', updated_at = ? WHERE id = ?`
  ).run(timestamp, old.id);
  db.prepare(
    `UPDATE claim_versions SET status = 'superseded', retracted_at = COALESCE(retracted_at, ?)
     WHERE memory_id = ? AND status = 'active'`
  ).run(timestamp, old.id);
  const key = old.key;
  if (key) db.prepare("DELETE FROM memory_keys WHERE memory_id = ?").run(old.id);
  const next = insertTaggedMemory(
    db,
    old.project,
    successorClaim(old, input),
    input.tags ? normalizeTags(input.tags) : old.tags,
    evidence,
    { supersedesId: old.id, supersedesVersionId: latestClaimVersionId(db, old.id) }
  );
  if (key) assignKey(db, old.project, key, next.id);
  return next;
}

function insertTaggedMemory(
  db: Database.Database,
  project: string,
  input: CandidateMemory,
  tags: string[],
  evidence?: EvidenceInput,
  chain: { supersedesId?: number; supersedesVersionId?: number } = {}
): SemanticMemory {
  const inserted = insertSemanticMemory(db, project, input, chain.supersedesId);
  const insertTag = db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)");
  for (const tag of tags) insertTag.run(inserted.id, tag);
  if (input.key) assignKey(db, project, input.key, inserted.id);
  const version = insertClaimVersion(db, inserted, input, chain.supersedesVersionId);
  if (evidence) attachEvidence(db, inserted.id, version, evidence, input.content);
  upsertMemoryEmbedding(db, inserted);
  return inserted;
}

/** Links quoted evidence from an episode to a memory's claim version. */
export function attachEvidence(
  db: Database.Database,
  memoryId: number,
  version: ClaimVersion,
  evidence: EvidenceInput,
  fallbackQuote: string
): void {
  const quote = evidence.quote ?? fallbackQuote;
  linkMemorySource(db, memoryId, evidence.sourceEpisodeId, quote);
  insertMemoryEvidence(db, version, evidence.sourceEpisodeId, quote, evidence.spanStart);
}

export function getMemoryByKey(
  db: Database.Database,
  project: string,
  key: string
): SemanticMemory | null {
  const row = db
    .prepare(
      `${MEMORY_WITH_LIFECYCLE_SELECT}
       JOIN memory_keys mk ON mk.memory_id = sm.id
       WHERE mk.project = ? AND mk.memory_key = ?`
    )
    .get(project, key) as SemanticMemoryRow | undefined;
  return row ? mapMemory(row) : null;
}

function assignKey(
  db: Database.Database,
  project: string,
  key: string,
  memoryId: number
): void {
  db.prepare(
    `INSERT INTO memory_keys (project, memory_key, memory_id) VALUES (?, ?, ?)
     ON CONFLICT(project, memory_key) DO UPDATE SET memory_id = excluded.memory_id`
  ).run(project, key, memoryId);
}

export async function extractMemories(
  db: Database.Database,
  project: string,
  episodeId: number
): Promise<SemanticMemory[]> {
  const episode = getEpisode(db, project, episodeId);
  if (!episode) return [];
  const candidates = await createLocalExtractor().extract(episode);
  return Promise.all(
    candidates.map((candidate) =>
      upsertSemanticMemory(db, project, candidate, episode.id, {
        quote: candidate.content,
        spanStart: episode.content.indexOf(candidate.content),
      })
    )
  );
}

export function explainMemory(
  db: Database.Database,
  project: string,
  memoryId: number
): MemoryExplanation {
  const memory = getMemory(db, project, memoryId);
  return explainMemoryHistory(
    db,
    project,
    memory,
    memory ? getMemorySources(db, memory.id) : []
  );
}

function reinforceMemory(
  db: Database.Database,
  existing: SemanticMemory,
  input: CandidateMemory,
  evidence?: EvidenceInput
): SemanticMemory {
  const row = db
    .prepare(
      `UPDATE semantic_memories
       SET confidence = MIN(1.0, confidence + 0.05),
           importance = MAX(importance, ?),
           last_confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?
       RETURNING *`
    )
    .get(input.importance ?? existing.importance, existing.id) as SemanticMemoryRow;
  const memory = mapMemory(row);
  const version = insertClaimVersion(
    db,
    memory,
    input,
    latestClaimVersionId(db, memory.id)
  );
  if (evidence) attachEvidence(db, row.id, version, evidence, input.content);
  return memory;
}

function insertSemanticMemory(
  db: Database.Database,
  project: string,
  input: CandidateMemory,
  supersedesId?: number
): SemanticMemory {
  const row = db
    .prepare(
      `
    INSERT INTO semantic_memories (
      project, scope, kind, subject, predicate, object, content, confidence,
      importance, valid_from, valid_to, last_confirmed_at, metadata_json, supersedes_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)
    RETURNING *
  `
    )
    .get(
      project,
      normalizeScope(input.scope),
      input.kind ?? "fact",
      input.subject,
      input.predicate ?? "states",
      input.object ?? null,
      input.content,
      input.confidence ?? 0.65,
      input.importance ?? 0.5,
      input.validFrom ?? null,
      input.validTo ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      supersedesId ?? null
    ) as SemanticMemoryRow;
  return mapMemory(row);
}

function findActiveEquivalent(
  db: Database.Database,
  project: string,
  input: CandidateMemory,
  tags: string[]
): SemanticMemory | null {
  const params: Array<string | number> = [
    project,
    input.subject,
    input.predicate ?? "states",
    input.content,
  ];
  const sameTags = tagPredicate(
    MEMORY_TAGS,
    "sm.id",
    { tags, match: "exact" },
    (value) => {
      params.push(value);
      return "?";
    }
  );
  const row = db
    .prepare(
      `${MEMORY_WITH_LIFECYCLE_SELECT}
       WHERE sm.project = ? AND sm.status = 'active'
         AND COALESCE(ml.status, 'active') = 'active'
         AND sm.subject = ? AND sm.predicate = ? AND sm.content = ?
         AND ${sameTags}
       ORDER BY sm.updated_at DESC
       LIMIT 1`
    )
    .get(...params) as SemanticMemoryRow | undefined;
  return row ? mapMemory(row) : null;
}
function findConflictingMemory(
  db: Database.Database,
  project: string,
  input: CandidateMemory,
  tags: string[]
): { memory: SemanticMemory; reason: string } | null {
  const params: Array<string | number> = [
    project,
    input.subject,
    input.predicate ?? "states",
  ];
  const sameTags = tagPredicate(
    MEMORY_TAGS,
    "sm.id",
    { tags, match: "exact" },
    (value) => {
      params.push(value);
      return "?";
    }
  );
  const rows = db
    .prepare(
      `${MEMORY_WITH_LIFECYCLE_SELECT}
       WHERE sm.project = ? AND sm.status = 'active'
         AND COALESCE(ml.status, 'active') = 'active'
         AND sm.subject = ? AND sm.predicate = ?
         AND ${sameTags}
       ORDER BY sm.updated_at DESC`
    )
    .all(...params) as SemanticMemoryRow[];
  for (const row of rows) {
    const memory = mapMemory(row);
    const reason = semanticConflictReason(memory, input);
    if (reason) return { memory, reason };
  }
  return null;
}

export function getMemory(
  db: Database.Database,
  project: string,
  id: number
): SemanticMemory | null {
  const row = db
    .prepare(`${MEMORY_WITH_LIFECYCLE_SELECT} WHERE sm.project = ? AND sm.id = ?`)
    .get(project, id) as SemanticMemoryRow | undefined;
  return row ? mapMemory(row) : null;
}

function linkMemorySource(
  db: Database.Database,
  memoryId: number,
  episodeId: number,
  quote: string
): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO memory_sources (memory_id, episode_id, quote)
    VALUES (?, ?, ?)
  `
  ).run(memoryId, episodeId, quote);
}

function upsertMemoryEmbedding(db: Database.Database, memory: SemanticMemory): void {
  upsertLocalEmbedding(db, "memory", memory.id, memory.content);
}
function upsertEpisodeEmbedding(db: Database.Database, episode: Episode): void {
  upsertLocalEmbedding(db, "episode", episode.id, episode.content);
}
