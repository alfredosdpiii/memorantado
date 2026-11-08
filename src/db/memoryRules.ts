import type { CandidateMemory, SemanticMemory, TagFilter } from "../memory/types.js";
import { MEMORY_TAGS, normalizeInstant, tagPredicate } from "../memory/tags.js";

/*
 * Backend-neutral rules of the semantic memory write and list paths, shared
 * by the sqlite modules and their pg mirrors.
 */

export type SemanticMemoryListOptions = {
  status?: string;
  lifecycleStatus?: "active" | "archived";
  tags?: TagFilter;
  /** Only memories last confirmed (or, never confirmed, created) before this instant. */
  confirmedBefore?: string;
  confirmedAfter?: string;
  /** "importance" (default) or "confirmed": least recently confirmed first. */
  sort?: "importance" | "confirmed";
  limit?: number;
  offset?: number;
};

/** WHERE clauses of a memory listing, shared by both backends. */
export function semanticListClauses(
  opts: SemanticMemoryListOptions,
  bind: (value: string | number) => string,
  projectClause: string
): string[] {
  const clauses = [projectClause];
  const confirmed = "COALESCE(sm.last_confirmed_at, sm.created_at)";
  if (opts.status) clauses.push(`sm.status = ${bind(opts.status)}`);
  if (opts.lifecycleStatus) {
    clauses.push(`COALESCE(ml.status, 'active') = ${bind(opts.lifecycleStatus)}`);
  }
  if (opts.tags) clauses.push(tagPredicate(MEMORY_TAGS, "sm.id", opts.tags, bind));
  const before = normalizeInstant(opts.confirmedBefore, "confirmedBefore");
  if (before) clauses.push(`${confirmed} < ${bind(before)}`);
  const after = normalizeInstant(opts.confirmedAfter, "confirmedAfter");
  if (after) clauses.push(`${confirmed} >= ${bind(after)}`);
  return clauses;
}

export function semanticListOrder(opts: SemanticMemoryListOptions): string {
  return opts.sort === "confirmed"
    ? "COALESCE(sm.last_confirmed_at, sm.created_at) ASC, sm.id ASC"
    : "sm.importance DESC, sm.updated_at DESC";
}

/** The claim a successor of `old` states: the input over the old claim. */
export function successorClaim(
  old: SemanticMemory,
  input: Partial<CandidateMemory> & { content: string }
): CandidateMemory {
  return {
    scope: input.scope ?? old.scope,
    kind: input.kind ?? old.kind,
    subject: input.subject ?? old.subject,
    predicate: input.predicate ?? old.predicate,
    object: input.object ?? old.object ?? undefined,
    content: input.content,
    confidence: input.confidence ?? old.confidence,
    importance: input.importance ?? old.importance,
    validFrom: input.validFrom,
    validTo: input.validTo,
    metadata: input.metadata ?? old.metadata ?? undefined,
  };
}

export function sameClaim(memory: SemanticMemory, input: CandidateMemory): boolean {
  return (
    memory.subject === input.subject &&
    memory.predicate === (input.predicate ?? "states") &&
    memory.content === input.content
  );
}

/**
 * Ids of memory $2 of project $1 and the superseded memories it replaced,
 * transitively (binds: project, id, project).
 */
export const SUPERSEDED_CHAIN_SQL = `
  WITH RECURSIVE chain(id, supersedes_id) AS (
    SELECT id, supersedes_id FROM semantic_memories WHERE project = $1 AND id = $2
    UNION
    SELECT sm.id, sm.supersedes_id FROM semantic_memories sm
    JOIN chain ON sm.id = chain.supersedes_id
    WHERE sm.project = $1 AND sm.status = 'superseded'
  )
  SELECT id FROM chain`;
