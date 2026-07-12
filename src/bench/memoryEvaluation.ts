import Database from "better-sqlite3";
import type Sqlite from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendEpisode,
  extractMemories,
  retrieveContext,
  upsertSemanticMemory,
} from "../db/hybridMemory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCHMARK_NAME = "mutation-retrieval-v2";
const BENCHMARK_PROJECT = "benchmark";
const PREFIX = "mutation-v2";

type RetrievalEvaluationMetrics = {
  cases: number;
  recallAtK: number;
  precisionAtK: number;
  falsePositiveRate: number;
  noAnswerAccuracy: number;
  mrr: number;
  ndcgAtK: number;
  evidenceSpanAccuracy: number;
  evidenceBudgetRetention: number;
  staleClaimLeakage: number;
  contradictionRetrievalRate: number;
  temporalAccuracy: number;
  tokenEfficiency: number;
};

type RetrievalEvaluationCase = {
  name: string;
  query: string;
  mode: "current" | "as_of";
  asOf?: string;
  tokenBudget?: number;
  expectedMemoryIds: number[];
  staleMemoryIds?: number[];
  conflictingMemoryIds?: number[];
  expectedEvidence?: { memoryId: number; quote: string; spanStart: number };
  expectedContextText?: string;
};

type MetricDelta = Record<keyof RetrievalEvaluationMetrics, number>;

export type RetrievalEvaluationResult = {
  id: number;
  name: string;
  metrics: RetrievalEvaluationMetrics;
  previousMetrics: RetrievalEvaluationMetrics | null;
  delta: MetricDelta | null;
  cases: Array<{
    name: string;
    rankedMemoryIds: number[];
    relevantRanks: number[];
    recall: number;
    precision: number;
    falsePositiveRate: number;
    noAnswerCorrect: number | null;
    evidenceRetained: number | null;
    reciprocalRank: number;
    ndcg: number;
    staleLeakage: number;
    contradictionRetrieved: number;
    temporalCorrect: number;
    evidenceCorrect: number | null;
    estimatedTokens: number;
  }>;
  report: string;
};

export async function runRetrievalEvaluation(
  db: Sqlite.Database,
  project: string,
  topK = 5
): Promise<RetrievalEvaluationResult> {
  const previousMetrics = readPreviousMetrics(db, project);
  const benchmarkDb = new Database(":memory:");
  benchmarkDb.pragma("foreign_keys = ON");
  benchmarkDb.exec(fs.readFileSync(path.join(__dirname, "../db/schema.sql"), "utf8"));
  try {
    const cases = await buildMutationCases(benchmarkDb);
    normalizeBenchmarkTimestamps(benchmarkDb);
    const results = await Promise.all(
      cases.map((fixture) => evaluateCase(benchmarkDb, fixture, topK))
    );
    const metrics = summarize(results);
    const delta = previousMetrics ? metricDelta(metrics, previousMetrics) : null;
    const report = renderReport(metrics, previousMetrics, delta, results, topK);
    const row = db
      .prepare(
        `INSERT INTO benchmark_runs (project, name, metrics_json, report)
         VALUES (?, ?, ?, ?) RETURNING id`
      )
      .get(project, BENCHMARK_NAME, JSON.stringify(metrics), report) as { id: number };
    return {
      id: row.id,
      name: BENCHMARK_NAME,
      metrics,
      previousMetrics,
      delta,
      cases: results,
      report,
    };
  } finally {
    benchmarkDb.close();
  }
}

function normalizeBenchmarkTimestamps(db: Sqlite.Database): void {
  const timestamp = "2026-01-01T00:00:00.000Z";
  db.prepare("UPDATE episodes SET created_at = ?").run(timestamp);
  db.prepare(
    "UPDATE semantic_memories SET created_at = ?, updated_at = ?, last_confirmed_at = ?"
  ).run(timestamp, timestamp, timestamp);
  db.prepare("UPDATE claim_versions SET recorded_at = ?").run(timestamp);
  db.prepare("UPDATE memory_evidence SET created_at = ?, ingested_at = ?").run(
    timestamp,
    timestamp
  );
}

async function buildMutationCases(
  db: Sqlite.Database
): Promise<RetrievalEvaluationCase[]> {
  const evidenceText = `${PREFIX} evidence marker. Ada uses SQLite.`;
  const episode = await appendEpisode(db, BENCHMARK_PROJECT, {
    actor: "Ada",
    content: evidenceText,
    source: "benchmark",
  });
  const extracted = await extractMemories(db, BENCHMARK_PROJECT, episode.id);
  const evidenceMemory = extracted.find(
    (memory) => memory.content === "Ada uses SQLite."
  );
  if (!evidenceMemory) throw new Error("benchmark evidence memory was not extracted");

  const historical = await upsertSemanticMemory(db, BENCHMARK_PROJECT, {
    kind: "preference",
    subject: `${PREFIX}-Ada`,
    predicate: "prefers",
    object: "Postgres",
    content: `${PREFIX}-Ada preferred Postgres in 2024.`,
    validFrom: "2024-01-01T00:00:00.000Z",
    validTo: "2025-01-01T00:00:00.000Z",
  });
  const current = await upsertSemanticMemory(db, BENCHMARK_PROJECT, {
    kind: "preference",
    subject: `${PREFIX}-Ada`,
    predicate: "prefers",
    object: "SQLite",
    content: `${PREFIX}-Ada prefers SQLite in 2025.`,
    validFrom: "2025-01-01T00:00:00.000Z",
  });
  const structuredOld = await upsertSemanticMemory(db, BENCHMARK_PROJECT, {
    kind: "fact",
    subject: `${PREFIX}-deploy`,
    predicate: "region",
    object: "east",
    content: `${PREFIX}-deploy region is east.`,
  });
  const structuredNew = await upsertSemanticMemory(db, BENCHMARK_PROJECT, {
    kind: "fact",
    subject: `${PREFIX}-deploy`,
    predicate: "region",
    object: "west",
    content: `${PREFIX}-deploy region is west.`,
  });
  await upsertSemanticMemory(db, BENCHMARK_PROJECT, {
    subject: `${PREFIX}-distractor`,
    predicate: "states",
    content: `${PREFIX} SQLite appears in unrelated documentation for another entity.`,
    importance: 1,
    confidence: 1,
  });
  await upsertSemanticMemory(db, BENCHMARK_PROJECT, {
    subject: `${PREFIX}-Ada`,
    predicate: "database",
    object: "MySQL",
    content: `${PREFIX}-Ada database migration notes mention MySQL.`,
    importance: 0.95,
    confidence: 0.95,
  });
  const longEpisodeText = `${"Filler context. ".repeat(80)}Needle evidence: quartz-lantern.${" Trailing context.".repeat(40)}`;
  const longEpisode = await appendEpisode(db, BENCHMARK_PROJECT, {
    actor: "Ada",
    content: longEpisodeText,
    source: "benchmark-long",
  });
  const budgetMemory = await upsertSemanticMemory(
    db,
    BENCHMARK_PROJECT,
    {
      subject: `${PREFIX}-budget`,
      predicate: "states",
      content: "Needle evidence: quartz-lantern.",
    },
    longEpisode.id,
    {
      quote: "Needle evidence: quartz-lantern.",
      spanStart: longEpisodeText.indexOf("Needle evidence: quartz-lantern."),
    }
  );
  const superseded = await upsertSemanticMemory(db, BENCHMARK_PROJECT, {
    kind: "fact",
    subject: `${PREFIX}-service`,
    predicate: "port",
    object: "3000",
    content: `${PREFIX}-service port is 3000.`,
    confidence: 1,
    importance: 1,
  });
  const replacement = await upsertSemanticMemory(db, BENCHMARK_PROJECT, {
    kind: "fact",
    subject: `${PREFIX}-service`,
    predicate: "port",
    object: "3789",
    content: `${PREFIX}-service port is 3789.`,
  });
  const conflict = db
    .prepare(
      `SELECT id FROM memory_conflicts
       WHERE project = ? AND memory_id = ? AND conflicting_id = ?`
    )
    .get(BENCHMARK_PROJECT, replacement.id, superseded.id) as { id: number };
  const timestamp = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `UPDATE semantic_memories SET status = 'superseded', updated_at = ? WHERE id = ?`
  ).run(timestamp, superseded.id);
  db.prepare(
    `UPDATE claim_versions SET status = 'superseded', retracted_at = ?
     WHERE memory_id = ? AND status = 'active'`
  ).run(timestamp, superseded.id);
  db.prepare(
    `UPDATE memory_conflicts SET resolution_status = 'resolved', resolved_memory_id = ?,
      resolved_at = ? WHERE id = ?`
  ).run(replacement.id, timestamp, conflict.id);
  const unrelated = await upsertSemanticMemory(db, BENCHMARK_PROJECT, {
    subject: `${PREFIX}-notes`,
    predicate: "states",
    content: `${PREFIX} validation passed.`,
  });

  return [
    {
      name: "evidence-span",
      query: `${PREFIX} SQLite`,
      mode: "current",
      expectedMemoryIds: [evidenceMemory.id],
      expectedEvidence: {
        memoryId: evidenceMemory.id,
        quote: "Ada uses SQLite.",
        spanStart: evidenceText.indexOf("Ada uses SQLite."),
      },
    },
    {
      name: "historical-as-of",
      query: `${PREFIX}-Ada prefers`,
      mode: "as_of",
      asOf: "2024-06-01T00:00:00.000Z",
      expectedMemoryIds: [historical.id],
      staleMemoryIds: [current.id],
    },
    {
      name: "current-state",
      query: `${PREFIX}-Ada prefers SQLite`,
      mode: "current",
      expectedMemoryIds: [current.id],
      staleMemoryIds: [historical.id],
    },
    {
      name: "structured-contradiction",
      query: `${PREFIX}-deploy region west`,
      mode: "current",
      expectedMemoryIds: [structuredNew.id],
      conflictingMemoryIds: [structuredOld.id],
    },
    {
      name: "unrelated-note",
      query: `${PREFIX} validation`,
      mode: "current",
      expectedMemoryIds: [unrelated.id],
    },
    {
      name: "superseded-high-confidence",
      query: `${PREFIX}-service port 3789`,
      mode: "current",
      expectedMemoryIds: [replacement.id],
      staleMemoryIds: [superseded.id],
    },
    {
      name: "no-answer",
      query: "zxqv-no-answer-token",
      mode: "current",
      expectedMemoryIds: [],
    },
    {
      name: "evidence-budget",
      query: "quartz-lantern",
      mode: "current",
      tokenBudget: 80,
      expectedMemoryIds: [budgetMemory.id],
      expectedContextText: "Needle evidence: quartz-lantern.",
    },
  ];
}

async function evaluateCase(
  db: Sqlite.Database,
  fixture: RetrievalEvaluationCase,
  topK: number
): Promise<RetrievalEvaluationResult["cases"][number]> {
  const pack = await retrieveContext(db, BENCHMARK_PROJECT, fixture.query, {
    limit: topK,
    mode: fixture.mode,
    asOf: fixture.asOf,
    tokenBudget: fixture.tokenBudget,
  });
  const rankedMemoryIds = pack.memories
    .map((hit) => hit.memory?.id ?? hit.version?.memoryId)
    .filter((id): id is number => id !== undefined);
  const expected = new Set(fixture.expectedMemoryIds);
  const relevantRanks = rankedMemoryIds.flatMap((id, index) =>
    expected.has(id) ? [index + 1] : []
  );
  const recall = expected.size ? relevantRanks.length / expected.size : 1;
  const precision = rankedMemoryIds.length
    ? relevantRanks.length / rankedMemoryIds.length
    : expected.size
      ? 0
      : 1;
  const falsePositiveRate = rankedMemoryIds.length
    ? (rankedMemoryIds.length - relevantRanks.length) / rankedMemoryIds.length
    : 0;
  const noAnswerCorrect = expected.size ? null : rankedMemoryIds.length === 0 ? 1 : 0;
  const evidenceRetained = fixture.expectedContextText
    ? pack.context.includes(fixture.expectedContextText)
      ? 1
      : 0
    : null;
  const reciprocalRank = relevantRanks.length ? 1 / relevantRanks[0] : 0;
  const dcg = relevantRanks.reduce((sum, rank) => sum + 1 / Math.log2(rank + 1), 0);
  const idealCount = Math.min(expected.size, topK);
  let idealDcg = 0;
  for (let rank = 1; rank <= idealCount; rank += 1) idealDcg += 1 / Math.log2(rank + 1);
  const stale = new Set(fixture.staleMemoryIds ?? []);
  const conflicts = new Set(fixture.conflictingMemoryIds ?? []);
  return {
    name: fixture.name,
    rankedMemoryIds,
    relevantRanks,
    recall,
    precision,
    falsePositiveRate,
    noAnswerCorrect,
    evidenceRetained,
    reciprocalRank,
    ndcg: idealDcg ? dcg / idealDcg : expected.size ? 0 : 1,
    staleLeakage: rankedMemoryIds.some((id) => stale.has(id)) ? 1 : 0,
    contradictionRetrieved: rankedMemoryIds.some((id) => conflicts.has(id)) ? 1 : 0,
    temporalCorrect: recall === 1 && !rankedMemoryIds.some((id) => stale.has(id)) ? 1 : 0,
    evidenceCorrect: evidenceAccuracy(db, fixture),
    estimatedTokens: pack.estimatedTokens,
  };
}
function summarize(
  results: RetrievalEvaluationResult["cases"]
): RetrievalEvaluationMetrics {
  return {
    cases: results.length,
    recallAtK: average(results.map((result) => result.recall)),
    precisionAtK: average(results.map((result) => result.precision)),
    falsePositiveRate: average(results.map((result) => result.falsePositiveRate)),
    noAnswerAccuracy: average(
      results.flatMap((result) =>
        result.noAnswerCorrect === null ? [] : [result.noAnswerCorrect]
      )
    ),
    mrr: average(results.map((result) => result.reciprocalRank)),
    ndcgAtK: average(results.map((result) => result.ndcg)),
    evidenceSpanAccuracy: average(
      results.flatMap((result) =>
        result.evidenceCorrect === null ? [] : [result.evidenceCorrect]
      )
    ),
    evidenceBudgetRetention: average(
      results.flatMap((result) =>
        result.evidenceRetained === null ? [] : [result.evidenceRetained]
      )
    ),
    staleClaimLeakage: average(results.map((result) => result.staleLeakage)),
    contradictionRetrievalRate: average(
      results.map((result) => result.contradictionRetrieved)
    ),
    temporalAccuracy: average(results.map((result) => result.temporalCorrect)),
    tokenEfficiency: average(
      results.map((result) =>
        result.estimatedTokens ? result.recall / result.estimatedTokens : result.recall
      )
    ),
  };
}

function evidenceAccuracy(
  db: Sqlite.Database,
  fixture: RetrievalEvaluationCase
): number | null {
  if (!fixture.expectedEvidence) return null;
  const row = db
    .prepare(
      `SELECT me.quote, me.span_start
       FROM memory_evidence me
       JOIN claim_versions cv ON cv.id = me.claim_version_id
       WHERE cv.project = ? AND cv.memory_id = ?
       ORDER BY me.id DESC LIMIT 1`
    )
    .get(BENCHMARK_PROJECT, fixture.expectedEvidence.memoryId) as
    | { quote: string; span_start: number | null }
    | undefined;
  return row?.quote === fixture.expectedEvidence.quote &&
    row.span_start === fixture.expectedEvidence.spanStart
    ? 1
    : 0;
}

function readPreviousMetrics(
  db: Sqlite.Database,
  project: string
): RetrievalEvaluationMetrics | null {
  const row = db
    .prepare(
      `SELECT metrics_json FROM benchmark_runs
       WHERE project = ? AND name = ? ORDER BY id DESC LIMIT 1`
    )
    .get(project, BENCHMARK_NAME) as { metrics_json: string } | undefined;
  return row ? (JSON.parse(row.metrics_json) as RetrievalEvaluationMetrics) : null;
}

function metricDelta(
  current: RetrievalEvaluationMetrics,
  previous: RetrievalEvaluationMetrics
): MetricDelta {
  const delta = {} as MetricDelta;
  for (const key of Object.keys(current) as Array<keyof RetrievalEvaluationMetrics>) {
    delta[key] = current[key] - previous[key];
  }
  return delta;
}

function renderReport(
  metrics: RetrievalEvaluationMetrics,
  previous: RetrievalEvaluationMetrics | null,
  delta: MetricDelta | null,
  cases: RetrievalEvaluationResult["cases"],
  topK: number
): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const deltaText = delta
    ? [
        "## Change from previous run",
        `- Recall@${topK}: ${delta.recallAtK >= 0 ? "+" : ""}${delta.recallAtK.toFixed(3)}`,
        `- MRR: ${delta.mrr >= 0 ? "+" : ""}${delta.mrr.toFixed(3)}`,
        `- nDCG@${topK}: ${delta.ndcgAtK >= 0 ? "+" : ""}${delta.ndcgAtK.toFixed(3)}`,
        `- Stale leakage: ${delta.staleClaimLeakage >= 0 ? "+" : ""}${delta.staleClaimLeakage.toFixed(3)}`,
        "",
      ]
    : ["Previous comparable run: none", ""];
  return [
    "# Mutation Retrieval Benchmark",
    "",
    `Cases: ${metrics.cases}`,
    `Recall@${topK}: ${percent(metrics.recallAtK)}`,
    `Precision@${topK}: ${percent(metrics.precisionAtK)}`,
    `False-positive rate: ${percent(metrics.falsePositiveRate)}`,
    `No-answer accuracy: ${percent(metrics.noAnswerAccuracy)}`,
    `MRR: ${metrics.mrr.toFixed(3)}`,
    `nDCG@${topK}: ${metrics.ndcgAtK.toFixed(3)}`,
    `Evidence-span accuracy: ${percent(metrics.evidenceSpanAccuracy)}`,
    `Evidence retained in budget: ${percent(metrics.evidenceBudgetRetention)}`,
    `Stale-claim leakage: ${percent(metrics.staleClaimLeakage)}`,
    `Contradiction retrieval rate: ${percent(metrics.contradictionRetrievalRate)}`,
    `Temporal accuracy: ${percent(metrics.temporalAccuracy)}`,
    `Token efficiency: ${metrics.tokenEfficiency.toFixed(5)} recall/token`,
    "",
    ...deltaText,
    "## Cases",
    ...cases.map(
      (result) =>
        `- ${result.name}: recall=${result.recall.toFixed(2)}, precision=${result.precision.toFixed(2)}, rr=${result.reciprocalRank.toFixed(2)}, nDCG=${result.ndcg.toFixed(2)}, ranks=[${result.relevantRanks.join(", ")}]`
    ),
    "",
    `Previous metrics: ${previous ? "available" : "none"}`,
    "This benchmark is a deterministic retrieval/evidence regression suite, not an official product benchmark.",
    "",
  ].join("\n");
}

function average(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}
