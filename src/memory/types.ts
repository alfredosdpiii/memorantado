export type MemoryStatus = "active" | "superseded" | "invalidated";
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
  type: "memory" | "episode";
  id: number;
  score: number;
  scoreParts: Record<string, number>;
  memory?: SemanticMemory;
  episode?: Episode;
  sources?: Episode[];
};

export type ContextPack = {
  query: string;
  intent: QueryIntent;
  memories: RetrievalHit[];
  episodes: RetrievalHit[];
  conflicts: MemoryConflict[];
  context: string;
  tokenBudget: number;
  estimatedTokens: number;
  latencyMs: number;
};
