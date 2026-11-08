import type { MemoryStore } from "../db/store.js";
import { contentHash } from "../memory/localEmbedding.js";
import {
  FILES,
  INVALIDATED,
  MEMORIES,
  QUERIES,
  REPLACEMENTS,
  SCOPES,
  SESSION_PROJECT,
} from "./ultronMemorySet.js";

const PROJECT = "ultron-bench";
const TOP_K = 5;

type QueryResult = {
  session: string;
  query: string;
  expected: string[];
  rankedKeys: Array<string | null>;
  recall: number | null;
  reciprocalRank: number | null;
  outOfScopeHits: number;
  retiredHits: number;
  latencyMs: number;
};

export type UltronRecallResult = {
  name: "ultron-scoped-recall-v1";
  topK: number;
  metrics: {
    queries: number;
    recallAtK: number;
    mrr: number;
    /** Share of returned memories outside the session's scopes (must be 0). */
    scopeLeakage: number;
    /** Returned memories that were replaced or invalidated (must be 0). */
    retiredLeakage: number;
    staleDetection: { precision: number; recall: number };
    latencyMs: { mean: number; p95: number };
  };
  queries: QueryResult[];
};

/**
 * Loads the Ultron-style memory set into `store` (project "ultron-bench",
 * which must be empty) and measures scoped recall as an Ultron session turn
 * does it: tags of the session, its project and the global scope, "any".
 * Deterministic for the local-hash embedding provider.
 */
export async function runUltronRecallBenchmark(
  store: MemoryStore
): Promise<UltronRecallResult> {
  const ids = await loadMemorySet(store);
  const retired = new Set<number>();
  for (const { key, content } of REPLACEMENTS) {
    retired.add(ids.get(key)!);
    const next = await store.upsertSemanticMemory(PROJECT, {
      subject: MEMORIES.find((memory) => memory.key === key)!.subject,
      content,
      key,
    });
    ids.set(key, next.id);
  }
  for (const key of INVALIDATED) {
    retired.add(ids.get(key)!);
    await store.invalidateMemory(PROJECT, ids.get(key)!, "benchmark: wrong");
  }
  const keyOf = new Map([...ids].map(([key, id]) => [id, key]));
  const queries: QueryResult[] = [];
  for (const { session, query, expected } of QUERIES) {
    const allowed: string[] = [
      SCOPES[session],
      SCOPES[SESSION_PROJECT[session]],
      SCOPES.g,
    ];
    const started = performance.now();
    const pack = await store.retrieveContext(PROJECT, query, {
      limit: TOP_K,
      tags: { tags: allowed, match: "any" },
    });
    const latencyMs = performance.now() - started;
    const hits = pack.memories.flatMap((hit) => (hit.memory ? [hit.memory] : []));
    const rankedKeys = hits.map((memory) => keyOf.get(memory.id) ?? null);
    const firstRank = rankedKeys.findIndex(
      (key) => key !== null && expected.includes(key)
    );
    queries.push({
      session,
      query,
      expected,
      rankedKeys,
      recall: expected.length
        ? expected.filter((key) => rankedKeys.includes(key)).length / expected.length
        : null,
      reciprocalRank: expected.length ? (firstRank < 0 ? 0 : 1 / (firstRank + 1)) : null,
      outOfScopeHits: hits.filter(
        (memory) => !memory.tags.some((tag) => allowed.includes(tag))
      ).length,
      retiredHits: hits.filter((memory) => retired.has(memory.id)).length,
      latencyMs,
    });
  }
  return {
    name: "ultron-scoped-recall-v1",
    topK: TOP_K,
    metrics: {
      queries: queries.length,
      recallAtK: mean(queries.flatMap((q) => (q.recall === null ? [] : [q.recall]))),
      mrr: mean(
        queries.flatMap((q) => (q.reciprocalRank === null ? [] : [q.reciprocalRank]))
      ),
      scopeLeakage:
        sum(queries.map((q) => q.outOfScopeHits)) /
        Math.max(1, sum(queries.map((q) => q.rankedKeys.length))),
      retiredLeakage: sum(queries.map((q) => q.retiredHits)),
      staleDetection: await measureStaleDetection(store, ids),
      latencyMs: {
        mean: round(mean(queries.map((q) => q.latencyMs))),
        p95: round(percentile95(queries.map((q) => q.latencyMs))),
      },
    },
    queries: queries.map((q) => ({ ...q, latencyMs: round(q.latencyMs) })),
  };
}

async function loadMemorySet(store: MemoryStore): Promise<Map<string, number>> {
  const snapshots = new Map<string, number>();
  for (const [source, versions] of Object.entries(FILES)) {
    const { snapshot } = await store.recordFileSnapshot(PROJECT, {
      source,
      content: versions.v1,
      tags: [SCOPES.p1],
    });
    snapshots.set(source, snapshot.episodeId);
  }
  const ids = new Map<string, number>();
  for (const memory of MEMORIES) {
    const stored = await store.upsertSemanticMemory(
      PROJECT,
      {
        kind: memory.type,
        subject: memory.subject,
        content: memory.content,
        key: memory.key,
        tags: [SCOPES[memory.scope]],
        metadata: {
          ultron_type: memory.type,
          ultron_evidence_class: memory.evidence,
        },
      },
      memory.file ? snapshots.get(memory.file.path) : undefined,
      memory.file ? { quote: memory.file.quote } : undefined
    );
    ids.set(memory.key, stored.id);
  }
  return ids;
}

/** Files move to v2; memories quoting a changed file must be reported stale. */
async function measureStaleDetection(
  store: MemoryStore,
  ids: Map<string, number>
): Promise<{ precision: number; recall: number }> {
  const files = Object.entries(FILES).map(([source, versions]) => ({
    source,
    contentHash: contentHash(versions.v2),
  }));
  const changed = new Set(
    Object.entries(FILES)
      .filter(([, versions]) => versions.v1 !== versions.v2)
      .map(([source]) => source)
  );
  const expected = new Set(
    MEMORIES.filter((memory) => memory.file && changed.has(memory.file.path)).map(
      (memory) => ids.get(memory.key)!
    )
  );
  const reported = new Set(
    (await store.findStaleFileEvidence(PROJECT, files)).map((entry) => entry.memoryId)
  );
  const hits = [...reported].filter((id) => expected.has(id)).length;
  return {
    precision: reported.size ? hits / reported.size : 1,
    recall: expected.size ? hits / expected.size : 1,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
    : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
