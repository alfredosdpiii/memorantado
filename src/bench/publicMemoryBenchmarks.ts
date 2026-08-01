import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, resolveStoreKind, type MemoryStore } from "../db/store.js";
import type { AppendEpisodeInput } from "../db/hybridMemory.js";
import type { ContextPack, Episode } from "../memory/types.js";
import { DATASET_URLS, STOPWORDS, TARGETS } from "./publicBenchmarkConfig.js";
import type { SuiteName } from "./publicBenchmarkConfig.js";

type Options = {
  suites: SuiteName[];
  maxCases: number;
  topK: number;
  tokenBudget: number;
  cacheDir: string;
};

type CaseResult = {
  suite: SuiteName;
  id: string;
  category: string;
  passed: boolean;
  answerCoverage: number;
  evidenceHit: boolean;
  latencyMs: number;
  estimatedTokens: number;
};

type SuiteSummary = {
  suite: SuiteName;
  cases: number;
  passRate: number;
  avgAnswerCoverage: number;
  avgLatencyMs: number;
  target: number;
  targetLabel: string;
  beatsTarget: boolean;
};

function parseArgs(): Options {
  const suites = getArg("suites", "locomo,longmemeval,dmr,ama")
    .split(",")
    .map((value) => value.trim())
    .filter(isSuiteName);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memorantado-benches-"));
  return {
    suites: suites.length ? suites : ["locomo", "longmemeval", "dmr", "ama"],
    maxCases: Number.parseInt(getArg("max-cases", "0"), 10),
    topK: Number.parseInt(getArg("top-k", "50"), 10),
    tokenBudget: Number.parseInt(getArg("token-budget", "7000"), 10),
    cacheDir: getArg("cache-dir", tempRoot),
  };
}

function getArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function isSuiteName(value: string): value is SuiteName {
  return ["locomo", "longmemeval", "dmr", "ama"].includes(value);
}

async function createBenchStore(): Promise<{
  store: MemoryStore;
  cleanup: () => Promise<void>;
}> {
  if (resolveStoreKind() === "pg") {
    const databaseUrl = process.env.MEMORANTADO_DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("MEMORANTADO_DATABASE_URL is required when MEMORANTADO_STORE=pg");
    }
    const { createScratchPgStore } = await import("../db/pg/admin.js");
    return createScratchPgStore(databaseUrl, "memorantado_bench_public");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorantado-bench-db-"));
  const store = await openStore({ dbPath: path.join(dir, "bench.sqlite") });
  return {
    store,
    async cleanup() {
      await store.close();
      fs.rmSync(dir, { force: true, recursive: true });
    },
  };
}

async function cachedText(
  url: string,
  cacheDir: string,
  fileName: string
): Promise<string> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = path.join(cacheDir, fileName);
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
  const text = await response.text();
  fs.writeFileSync(filePath, text);
  return text;
}

async function append(
  store: MemoryStore,
  project: string,
  input: AppendEpisodeInput
): Promise<void> {
  await store.appendEpisode(project, input);
}

async function evaluate(
  store: MemoryStore,
  suite: SuiteName,
  project: string,
  id: string,
  category: string,
  question: string,
  answer: string,
  evidenceIds: string[],
  opts: Options
): Promise<CaseResult> {
  const pack = await store.retrieveContext(project, question, {
    limit: opts.topK,
    tokenBudget: opts.tokenBudget,
  });
  const answerCoverage = coverage(answer, pack.context);
  const evidenceHit =
    suite === "ama"
      ? hitsAllEvidence(pack, evidenceIds)
      : hitsAnyEvidence(pack, evidenceIds);
  return {
    suite,
    id,
    category,
    passed: evidenceHit || answerCoverage >= threshold(suite, answer),
    answerCoverage,
    evidenceHit,
    latencyMs: pack.latencyMs,
    estimatedTokens: pack.estimatedTokens,
  };
}

async function runLocomo(store: MemoryStore, opts: Options): Promise<CaseResult[]> {
  const text = await cachedText(DATASET_URLS.locomo, opts.cacheDir, "locomo10.json");
  const rows = JSON.parse(text) as Record<string, unknown>[];
  const results: CaseResult[] = [];
  for (const [index, row] of rows.entries()) {
    const sampleId = stringField(row, "sample_id") || String(index);
    const project = `bench-locomo-${sampleId}`;
    await ingestLocomo(store, project, objectField(row, "conversation"));
    for (const qa of arrayField(row, "qa")) {
      if (limitReached(results, opts)) return results;
      const item = qa as Record<string, unknown>;
      const category = String(item.category ?? "");
      if (!["1", "2", "3", "4"].includes(category)) continue;
      results.push(
        await evaluate(
          store,
          "locomo",
          project,
          stringField(item, "question_id") || String(results.length),
          category,
          stringField(item, "question"),
          stringField(item, "answer"),
          arrayField(item, "evidence").map(String),
          opts
        )
      );
    }
  }
  return results;
}
async function runLongMemEval(store: MemoryStore, opts: Options): Promise<CaseResult[]> {
  const text = await cachedText(
    DATASET_URLS.longmemeval,
    opts.cacheDir,
    "longmemeval_s_cleaned.json"
  );
  const rows = JSON.parse(text) as Record<string, unknown>[];
  const results: CaseResult[] = [];
  for (const [index, row] of rows.entries()) {
    if (limitReached(results, opts)) break;
    const id = stringField(row, "question_id") || String(index);
    const project = `bench-longmemeval-${index}`;
    await ingestLongMemEval(store, project, row);
    results.push(
      await evaluate(
        store,
        "longmemeval",
        project,
        id,
        stringField(row, "question_type"),
        stringField(row, "question"),
        stringField(row, "answer"),
        stringArray(row.answer_session_ids),
        opts
      )
    );
  }
  return results;
}
async function runDmr(store: MemoryStore, opts: Options): Promise<CaseResult[]> {
  const text = await cachedText(
    DATASET_URLS.dmr,
    opts.cacheDir,
    "msc_self_instruct.jsonl"
  );
  const results: CaseResult[] = [];
  for (const [index, line] of text.split("\n").filter(Boolean).entries()) {
    if (limitReached(results, opts)) break;
    const row = JSON.parse(line) as Record<string, unknown>;
    const project = `bench-dmr-${index}`;
    await ingestDmr(store, project, row);
    const instruction = objectField(row, "self_instruct");
    results.push(
      await evaluate(
        store,
        "dmr",
        project,
        String(index),
        "msc-self-instruct",
        stringField(instruction, "B"),
        stringField(instruction, "A"),
        [],
        opts
      )
    );
  }
  return results;
}

async function runAma(store: MemoryStore, opts: Options): Promise<CaseResult[]> {
  const text = await cachedText(DATASET_URLS.ama, opts.cacheDir, "ama_open_end_qa.jsonl");
  const results: CaseResult[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    if (limitReached(results, opts)) break;
    const row = JSON.parse(line) as Record<string, unknown>;
    const project = `bench-ama-${stringField(row, "episode_id")}`;
    await ingestAma(store, project, row);
    for (const qa of arrayField(row, "qa_pairs")) {
      if (limitReached(results, opts)) return results;
      const item = qa as Record<string, unknown>;
      results.push(
        await evaluate(
          store,
          "ama",
          project,
          stringField(item, "question_uuid") || String(results.length),
          stringField(item, "type"),
          stringField(item, "question"),
          stringField(item, "answer"),
          stepEvidenceIds(stringField(item, "question")),
          opts
        )
      );
    }
  }
  return results;
}

async function ingestLocomo(
  store: MemoryStore,
  project: string,
  conversation: Record<string, unknown>
): Promise<void> {
  for (const [key, value] of Object.entries(conversation)) {
    if (!/^session_\d+$/.test(key)) continue;
    const date = stringField(conversation, `${key}_date_time`);
    const turns = value as Record<string, unknown>[];
    await append(store, project, {
      content: `[${date}] ${key}\n${formatLocomoTurns(turns)}`,
      metadata: { benchmark: "locomo", session: key, date },
      source: "locomo",
    });
    for (const turn of turns) {
      const diaId = stringField(turn, "dia_id");
      await append(store, project, {
        actor: stringField(turn, "speaker"),
        content: `[${date}] ${diaId} ${stringField(turn, "speaker")}: ${stringField(turn, "text")}`,
        metadata: { benchmark: "locomo", session: key, diaId, date },
        source: "locomo",
      });
    }
  }
}

async function ingestLongMemEval(
  store: MemoryStore,
  project: string,
  row: Record<string, unknown>
): Promise<void> {
  const sessions = arrayField(row, "haystack_sessions");
  const ids = stringArray(row.haystack_session_ids);
  const dates = stringArray(row.haystack_dates);
  for (const [index, session] of sessions.entries()) {
    const messages = session as Record<string, unknown>[];
    for (let offset = 0; offset < messages.length; offset += 2) {
      const pair = messages.slice(offset, offset + 2);
      await append(store, project, {
        content: formatMessages(pair, dates[index], ids[index]),
        metadata: {
          benchmark: "longmemeval",
          sessionId: ids[index],
          date: dates[index],
          hasAnswer: pair.some((message) => message.has_answer === true),
        },
        source: "longmemeval",
      });
    }
  }
}

async function ingestDmr(
  store: MemoryStore,
  project: string,
  row: Record<string, unknown>
): Promise<void> {
  for (const [sessionIndex, session] of arrayField(row, "previous_dialogs").entries()) {
    await appendDialog(store, project, session as Record<string, unknown>, sessionIndex);
  }
  await append(store, project, {
    content: formatDialog(arrayField(row, "dialog") as Record<string, unknown>[]),
    metadata: { benchmark: "dmr", sessionIndex: "current" },
    source: "dmr",
  });
}

async function ingestAma(
  store: MemoryStore,
  project: string,
  row: Record<string, unknown>
): Promise<void> {
  for (const turn of arrayField(row, "trajectory")) {
    const item = turn as Record<string, unknown>;
    await append(store, project, {
      content: `Step ${String(item.turn_idx)} action ${String(item.action)} observation ${String(item.observation)}`,
      metadata: {
        benchmark: "ama",
        episodeId: row.episode_id,
        turnIdx: item.turn_idx,
      },
      source: "ama",
    });
  }
}

async function appendDialog(
  store: MemoryStore,
  project: string,
  session: Record<string, unknown>,
  sessionIndex: number
): Promise<void> {
  await append(store, project, {
    content: formatDialog(arrayField(session, "dialog") as Record<string, unknown>[]),
    metadata: {
      benchmark: "dmr",
      sessionIndex,
      timeBack: stringField(session, "time_back"),
    },
    source: "dmr",
  });
}

function formatMessages(
  messages: Record<string, unknown>[],
  date: string,
  sessionId: string
): string {
  const body = messages
    .map((message) => `${String(message.role)}: ${String(message.content)}`)
    .join("\n");
  return `[${date}] session:${sessionId}\n${body}`;
}

function formatDialog(messages: Record<string, unknown>[]): string {
  return messages
    .map(
      (message, index) =>
        `${String(message.id ?? `speaker_${index}`)}: ${String(message.text)}`
    )
    .join("\n");
}

function hitsAnyEvidence(pack: ContextPack, evidenceIds: string[]): boolean {
  if (!evidenceIds.length) return false;
  const haystack = `${pack.context}\n${retrievedEpisodes(pack)
    .map((episode) => JSON.stringify(episode.metadata))
    .join("\n")}`.toLowerCase();
  return evidenceIds.some((evidence) => haystack.includes(evidence.toLowerCase()));
}

function hitsAllEvidence(pack: ContextPack, evidenceIds: string[]): boolean {
  if (!evidenceIds.length) return false;
  const haystack = pack.context.toLowerCase();
  return evidenceIds.every((evidence) => haystack.includes(evidence.toLowerCase()));
}

function stepEvidenceIds(question: string): string[] {
  const steps = new Set<number>();
  for (const match of question.matchAll(/\bsteps?\s+([0-9,\sandto-]+)/gi)) {
    const value = match[1];
    const range = value.match(/(\d+)\s*(?:to|-)\s*(\d+)/i);
    if (range) {
      const start = Number.parseInt(range[1], 10);
      const end = Number.parseInt(range[2], 10);
      for (let step = start; step <= end; step += 1) steps.add(step);
    }
    for (const number of value.match(/\d+/g) ?? []) {
      steps.add(Number.parseInt(number, 10));
    }
  }
  return Array.from(steps, (step) => `Step ${step}`);
}

function formatLocomoTurns(turns: Record<string, unknown>[]): string {
  return turns
    .map(
      (turn) =>
        `${stringField(turn, "dia_id")} ${stringField(turn, "speaker")}: ${stringField(turn, "text")}`
    )
    .join("\n");
}

function retrievedEpisodes(pack: ContextPack): Episode[] {
  const episodes = pack.episodes.flatMap((hit) => (hit.episode ? [hit.episode] : []));
  const sources = pack.memories.flatMap((hit) => hit.sources ?? []);
  return [...episodes, ...sources];
}

function coverage(answer: string, context: string): number {
  const answerTokens = tokens(answer);
  if (!answerTokens.length) return 0;
  const contextTokens = new Set(tokens(context));
  const hits = answerTokens.filter((token) => contextTokens.has(token)).length;
  return hits / answerTokens.length;
}

function tokens(text: string): string[] {
  return Array.from(new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []))
    .map(stemToken)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function stemToken(token: string): string {
  if (/^\d+$/.test(token)) return token;
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}

function threshold(suite: SuiteName, answer: string): number {
  if (suite === "ama") return 0.35;
  if (suite === "dmr") return 0.5;
  return tokens(answer).length <= 3 ? 1 : 0.6;
}

function summarize(suite: SuiteName, results: CaseResult[]): SuiteSummary {
  const target = TARGETS[suite];
  const passRate = average(results.map((result) => (result.passed ? 1 : 0)));
  return {
    suite,
    cases: results.length,
    passRate,
    avgAnswerCoverage: average(results.map((result) => result.answerCoverage)),
    avgLatencyMs: average(results.map((result) => result.latencyMs)),
    target: target.score,
    targetLabel: target.label,
    beatsTarget: passRate > target.score,
  };
}

function average(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function limitReached(results: CaseResult[], opts: Options): boolean {
  return opts.maxCases > 0 && results.length >= opts.maxCases;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function objectField(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayField(row: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(row[key]) ? row[key] : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

async function runSuite(
  suite: SuiteName,
  store: MemoryStore,
  opts: Options
): Promise<CaseResult[]> {
  if (suite === "locomo") return runLocomo(store, opts);
  if (suite === "longmemeval") return runLongMemEval(store, opts);
  if (suite === "dmr") return runDmr(store, opts);
  return runAma(store, opts);
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const bench = await createBenchStore();
  try {
    const summaries: SuiteSummary[] = [];
    const details: CaseResult[] = [];
    for (const suite of opts.suites) {
      const results = await runSuite(suite, bench.store, opts);
      summaries.push(summarize(suite, results));
      details.push(...results);
    }
    console.log(JSON.stringify({ options: opts, summaries, details }, null, 2));
  } finally {
    await bench.cleanup();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
