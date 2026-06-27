import type {
  Episode,
  MemoryConflict,
  MemoryStatus,
  MemoryScope,
  QueryIntent,
  SemanticMemory,
} from "../memory/types.js";

export type EpisodeRow = {
  id: number;
  project: string;
  session: string | null;
  actor: string | null;
  role: string;
  content: string;
  source: string | null;
  metadata_json: string | null;
  created_at: string;
};

export type SemanticMemoryRow = {
  id: number;
  project: string;
  scope: string;
  kind: string;
  subject: string;
  predicate: string;
  object: string | null;
  content: string;
  confidence: number;
  importance: number;
  status: MemoryStatus;
  valid_from: string | null;
  valid_to: string | null;
  last_confirmed_at: string | null;
  supersedes_id: number | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

export type MemoryConflictRow = {
  id: number;
  project: string;
  memory_id: number;
  conflicting_id: number;
  reason: string;
  resolution_status: "open" | "resolved" | "ignored";
  resolved_memory_id: number | null;
  created_at: string;
  resolved_at: string | null;
};

function parseJson<T>(value: string | null): T | null {
  return value ? (JSON.parse(value) as T) : null;
}

export function normalizeScope(scope?: string): MemoryScope {
  const allowed = new Set(["user", "agent", "session", "project", "global"]);
  return allowed.has(scope ?? "") ? (scope as MemoryScope) : "project";
}

export function mapEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    project: row.project,
    session: row.session,
    actor: row.actor,
    role: row.role,
    content: row.content,
    source: row.source,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
    createdAt: row.created_at,
  };
}

export function mapMemory(row: SemanticMemoryRow): SemanticMemory {
  return {
    id: row.id,
    project: row.project,
    scope: normalizeScope(row.scope),
    kind: row.kind,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    content: row.content,
    confidence: row.confidence,
    importance: row.importance,
    status: row.status,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    lastConfirmedAt: row.last_confirmed_at,
    supersedesId: row.supersedes_id,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapConflict(row: MemoryConflictRow): MemoryConflict {
  return {
    id: row.id,
    project: row.project,
    memoryId: row.memory_id,
    conflictingId: row.conflicting_id,
    reason: row.reason,
    resolutionStatus: row.resolution_status,
    resolvedMemoryId: row.resolved_memory_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function ftsQuery(query: string): string {
  return query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `"${word}"*`)
    .join(" OR ");
}

export function overlapScore(query: string, text: string): number {
  const queryWords = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (!queryWords.size) return 0;
  const textWords = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  let matches = 0;
  for (const word of queryWords) if (textWords.has(word)) matches += 1;
  return matches / queryWords.size;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function inferIntent(query: string): QueryIntent {
  if (/\b(before|after|when|history|previous|past|timeline)\b/i.test(query)) {
    return "historical_range";
  }
  if (/\b(prefer|preference|like|want|need)\b/i.test(query)) return "preference";
  if (/\b(who|what|where|which entity|tell me about)\b/i.test(query)) {
    return "entity_lookup";
  }
  if (/\b(why|how|connect|relationship|related)\b/i.test(query)) return "multi_hop";
  if (/\b(unsure|uncertain|maybe)\b/i.test(query)) return "uncertain";
  return "current_state";
}
