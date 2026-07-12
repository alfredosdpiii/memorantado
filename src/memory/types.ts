export type MemoryStatus = "active" | "superseded" | "invalidated";
export type ClaimVersion = {
  id: number;
  memoryId: number;
  project: string;
  scope: MemoryScope;
  kind: string;
  subject: string;
  predicate: string;
  object: string | null;
  content: string;
  confidence: number;
  importance: number;
  status: MemoryStatus;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  retractedAt: string | null;
  supersedesVersionId: number | null;
  metadata: Record<string, unknown> | null;
  extractorId: string;
  extractorVersion: string;
};

export type MemoryEvidence = {
  id: number;
  claimVersionId: number;
  episodeId: number;
  quote: string;
  spanStart: number | null;
  spanEnd: number | null;
  contentHash: string;
  polarity: "supports" | "contradicts" | "mentions";
  actor: string | null;
  source: string | null;
  observedAt: string | null;
  ingestedAt: string;
  extractorId: string;
  extractorVersion: string;
  createdAt: string;
};

export type ConflictResolutionEvent = {
  id: number;
  conflictId: number;
  project: string;
  action: "resolved" | "ignored";
  resolvedMemoryId: number | null;
  actor: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type RetrievalMode = "current" | "as_of" | "history" | "all";
export type MemoryScope = "user" | "agent" | "session" | "project" | "global";
export type QueryIntent =
  | "current_state"
  | "historical_range"
  | "preference"
  | "entity_lookup"
  | "multi_hop"
  | "uncertain";

export type Episode = {
  id: number;
  project: string;
  session: string | null;
  actor: string | null;
  role: string;
  content: string;
  source: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type SemanticMemory = {
  id: number;
  project: string;
  scope: MemoryScope;
  kind: string;
  subject: string;
  predicate: string;
  object: string | null;
  content: string;
  confidence: number;
  importance: number;
  status: MemoryStatus;
  validFrom: string | null;
  validTo: string | null;
  lastConfirmedAt: string | null;
  supersedesId: number | null;
  metadata: Record<string, unknown> | null;
  lifecycleStatus: "active" | "archived";
  archiveReason: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CandidateMemory = {
  scope?: MemoryScope;
  kind?: string;
  subject: string;
  predicate?: string;
  object?: string;
  content: string;
  confidence?: number;
  importance?: number;
  validFrom?: string;
  validTo?: string;
  metadata?: Record<string, unknown>;
};

export type MemoryConflict = {
  id: number;
  project: string;
  memoryId: number;
  conflictingId: number;
  reason: string;
  resolutionStatus: "open" | "resolved" | "ignored";
  resolvedMemoryId: number | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type RetrievalHit = {
  type: "memory" | "episode" | "claim_version";
  id: number;
  score: number;
  scoreParts: Record<string, number>;
  memory?: SemanticMemory;
  version?: ClaimVersion;
  episode?: Episode;
  sources?: Episode[];
};

export type GraphContext = {
  entities: Array<{
    name: string;
    entityType: string;
    observations: string[];
  }>;
  relations: Array<{
    from: string;
    to: string;
    relationType: string;
  }>;
};

export type ContextPack = {
  query: string;
  intent: QueryIntent;
  mode: RetrievalMode;
  asOf: string | null;
  recordedAt: string | null;
  memories: RetrievalHit[];
  episodes: RetrievalHit[];
  conflicts: MemoryConflict[];
  graph: GraphContext;
  context: string;
  tokenBudget: number;
  estimatedTokens: number;
  latencyMs: number;
};
