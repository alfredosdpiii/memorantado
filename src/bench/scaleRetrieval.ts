/**
 * 25k scale scenario: seeds 25,000 semantic memories + 25,000 episodes with
 * a deterministic RNG, then measures retrieval on the configured backend.
 *
 * What it demonstrates:
 * - Needle rows planted as the OLDEST rows (ids 1-3) carry a 2-character
 *   token that only the vector channel can match (bm25 tokenization ignores
 *   words of length <= 2, embeddings include every token). On sqlite these
 *   rows fall outside the 5000-row MAX_RETRIEVAL_SCAN window and are
 *   unreachable; on pg the HNSW KNN channel covers the whole corpus.
 * - p50/p95/mean/max latency over 200 deterministic retrieval queries.
 *
 * Usage:
 *   npx tsx src/bench/scaleRetrieval.ts            # sqlite (temp file)
 *   MEMORANTADO_STORE=pg MEMORANTADO_DATABASE_URL=... \
 *     npx tsx src/bench/scaleRetrieval.ts          # pg (scratch database)
 *
 * Results are printed as JSON and persisted as a "scale-25k" benchmark run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db/db.js";
import { migrate } from "../db/migrate.js";
import { resolveStoreKind, type MemoryStore, type StoreKind } from "../db/store.js";
import { SqliteStore } from "../db/sqliteStore.js";
import { contentHash, embedText, embeddingDimension } from "../memory/localEmbedding.js";

const ROW_COUNT = 25_000;
const PROJECT = "scale25k";
const BENCHMARK_NAME = "scale-25k";
const LATENCY_QUERIES = 200;
const QUERY_LIMIT = 8;

// Oldest rows, outside sqlite's newest-5000 vector scan. The 2-char tokens
// are invisible to bm25 tokenization (length <= 2) but present in local-hash
// embeddings, so only the vector channel can retrieve them.
const NEEDLES = [
  { id: 1, token: "qx" },
  { id: 2, token: "wq" },
  { id: 3, token: "zj" },
] as const;

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = [
  "al",
  "be",
  "cor",
  "di",
  "el",
  "fi",
  "gor",
  "ha",
  "in",
  "je",
  "ko",
  "lu",
  "mon",
  "ni",
  "or",
  "pa",
  "qu",
  "ri",
  "so",
  "tu",
  "ve",
  "wo",
  "xi",
  "ya",
  "zo",
];

function buildVocabulary(rng: () => number, size: number): string[] {
  const words = new Set<string>();
  while (words.size < size) {
    const parts = 2 + Math.floor(rng() * 2);
    let word = "";
    for (let index = 0; index < parts; index += 1) {
      word += SYLLABLES[Math.floor(rng() * SYLLABLES.length)];
    }
    if (word.length > 2) words.add(word);
  }
  return [...words];
}

/** Bucket index and sign of a single-token local-hash embedding. */
function bucketAndSign(word: string): { index: number; sign: number } {
  const vector = embedText(word);
  for (let index = 0; index < vector.length; index += 1) {
    if (vector[index] !== 0) return { index, sign: Math.sign(vector[index]) };
  }
  throw new Error(`empty embedding for ${word}`);
}

// Words that hash into a needle token's bucket with the same sign would add
// positive dot-product mass to arbitrary filler rows; at 25k rows enough of
// them would outrank the needle inside the KNN channel's limit*4 window.
// Excluding them keeps the needles the dominant match for their token, which
// is what this scenario isolates (scan coverage, not collision ranking).
function filterNeedleCollisions(vocabulary: string[]): string[] {
  const needleKeys = NEEDLES.map((needle) => bucketAndSign(needle.token));
  const filtered = vocabulary.filter((word) => {
    const key = bucketAndSign(word);
    return !needleKeys.some(
      (needleKey) => needleKey.index === key.index && needleKey.sign === key.sign
    );
  });
  if (filtered.length < vocabulary.length / 2) {
    throw new Error("vocabulary too small after needle-bucket filtering");
  }
  return filtered;
}

type Fixture = {
  memories: Array<{ id: number; subject: string; content: string }>;
  episodes: Array<{ id: number; actor: string; content: string }>;
  hotWords: string[];
};

function buildFixture(): Fixture {
  const rng = mulberry32(42);
  const vocabulary = filterNeedleCollisions(buildVocabulary(rng, 800));
  const needleTokens = new Set(NEEDLES.map((needle) => needle.token));
  const pick = (): string => vocabulary[Math.floor(rng() * vocabulary.length)];
  const sentence = (min: number, max: number): string => {
    const length = min + Math.floor(rng() * (max - min + 1));
    const words: string[] = [];
    for (let index = 0; index < length; index += 1) words.push(pick());
    return `${words.join(" ")}.`;
  };
  // Needle content stays short (3 tokens) so a single-token query's cosine
  // against it (~0.46) clears MIN_VECTOR_RELEVANCE (0.35); "lantern"/"orchid"
  // cannot be produced by the syllable vocabulary, so the needles stay the
  // only rows containing them.
  const memories: Fixture["memories"] = [];
  for (let id = 1; id <= ROW_COUNT; id += 1) {
    const needle = NEEDLES.find((candidate) => candidate.id === id);
    const content = needle ? `${needle.token} lantern orchid.` : sentence(6, 9);
    for (const token of needleTokens) {
      if (!needle && content.includes(token)) throw new Error("needle token leak");
    }
    memories.push({ id, subject: `scale-entity-${id % 500}`, content });
  }
  const episodes: Fixture["episodes"] = [];
  for (let id = 1; id <= ROW_COUNT; id += 1) {
    const content = id === 1 ? `${NEEDLES[0].token} lantern orchid.` : sentence(6, 10);
    episodes.push({ id, actor: `actor-${id % 50}`, content });
  }
  return { memories, episodes, hotWords: vocabulary.slice(0, 24) };
}

// ---------------------------------------------------------------------------
// bulk seeding (scale fixture only; write semantics are covered by tests)
// ---------------------------------------------------------------------------

function seedSqlite(dbPath: string, fixture: Fixture): void {
  const db = openDb(dbPath);
  migrate(db);
  const insertMemory = db.prepare(
    `INSERT INTO semantic_memories (id, project, kind, subject, predicate, content, confidence, importance)
     VALUES (?, ?, 'fact', ?, 'states', ?, 0.65, 0.5)`
  );
  const insertMemoryEmbedding = db.prepare(
    `INSERT INTO memory_embeddings (memory_id, provider, dimension, vector_json, content_hash)
     VALUES (?, 'local-hash', ?, ?, ?)`
  );
  const insertEpisode = db.prepare(
    `INSERT INTO episodes (id, project, actor, role, content, source)
     VALUES (?, ?, ?, 'user', ?, 'scale')`
  );
  const insertEpisodeEmbedding = db.prepare(
    `INSERT INTO episode_embeddings (episode_id, provider, dimension, vector_json, content_hash)
     VALUES (?, 'local-hash', ?, ?, ?)`
  );
  const dimension = embeddingDimension();
  db.transaction(() => {
    for (const memory of fixture.memories) {
      insertMemory.run(memory.id, PROJECT, memory.subject, memory.content);
      insertMemoryEmbedding.run(
        memory.id,
        dimension,
        JSON.stringify(embedText(memory.content)),
        contentHash(memory.content)
      );
    }
    for (const episode of fixture.episodes) {
      insertEpisode.run(episode.id, PROJECT, episode.actor, episode.content);
      insertEpisodeEmbedding.run(
        episode.id,
        dimension,
        JSON.stringify(embedText(episode.content)),
        contentHash(episode.content)
      );
    }
  })();
  db.close();
}

async function seedPg(databaseUrl: string, fixture: Fixture): Promise<MemoryStore> {
  const { createPgDatabase, dropPgDatabase, databaseUrlForName } =
    await import("../db/pg/admin.js");
  const { createPool, toVectorLiteral } = await import("../db/pg/client.js");
  const { ensurePgSchema } = await import("../db/pg/schema.js");
  const { createPgStore } = await import("../db/pg/pgStore.js");
  const name = "memorantado_scale_25k";
  await dropPgDatabase(databaseUrl, name);
  await createPgDatabase(databaseUrl, name);
  const url = databaseUrlForName(databaseUrl, name);
  const pool = createPool(url);
  await ensurePgSchema(pool);
  const batchSize = 1000;
  for (let start = 0; start < fixture.memories.length; start += batchSize) {
    const batch = fixture.memories.slice(start, start + batchSize);
    await pool.query(
      `INSERT INTO semantic_memories (id, project, kind, subject, predicate, content, confidence, importance)
       SELECT id, $1, 'fact', subject, 'states', content, 0.65, 0.5
       FROM unnest($2::int[], $3::text[], $4::text[]) AS rows(id, subject, content)`,
      [
        PROJECT,
        batch.map((row) => row.id),
        batch.map((row) => row.subject),
        batch.map((row) => row.content),
      ]
    );
    await pool.query(
      `INSERT INTO memory_embeddings (memory_id, project, provider, dimension, vector_json, embedding, content_hash)
       SELECT id, $1, 'local-hash', $2, vector_json, embedding::vector, content_hash
       FROM unnest($3::int[], $4::text[], $5::text[], $6::text[])
         AS rows(id, vector_json, embedding, content_hash)`,
      [
        PROJECT,
        embeddingDimension(),
        batch.map((row) => row.id),
        batch.map((row) => JSON.stringify(embedText(row.content))),
        batch.map((row) => toVectorLiteral(embedText(row.content))),
        batch.map((row) => contentHash(row.content)),
      ]
    );
  }
  for (let start = 0; start < fixture.episodes.length; start += batchSize) {
    const batch = fixture.episodes.slice(start, start + batchSize);
    await pool.query(
      `INSERT INTO episodes (id, project, actor, role, content, source)
       SELECT id, $1, actor, 'user', content, 'scale'
       FROM unnest($2::int[], $3::text[], $4::text[]) AS rows(id, actor, content)`,
      [
        PROJECT,
        batch.map((row) => row.id),
        batch.map((row) => row.actor),
        batch.map((row) => row.content),
      ]
    );
    await pool.query(
      `INSERT INTO episode_embeddings (episode_id, project, provider, dimension, vector_json, embedding, content_hash)
       SELECT id, $1, 'local-hash', $2, vector_json, embedding::vector, content_hash
       FROM unnest($3::int[], $4::text[], $5::text[], $6::text[])
         AS rows(id, vector_json, embedding, content_hash)`,
      [
        PROJECT,
        embeddingDimension(),
        batch.map((row) => row.id),
        batch.map((row) => JSON.stringify(embedText(row.content))),
        batch.map((row) => toVectorLiteral(embedText(row.content))),
        batch.map((row) => contentHash(row.content)),
      ]
    );
  }
  for (const table of ["semantic_memories", "episodes"] as const) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), $1, true)`,
      [ROW_COUNT]
    );
  }
  await pool.end();
  return createPgStore(url);
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

type ScaleResult = {
  backend: StoreKind;
  rows: { memories: number; episodes: number };
  needles: Array<{ token: string; id: number; found: boolean }>;
  episodeNeedle: { token: string; id: number; found: boolean };
  latencyMs: { p50: number; p95: number; mean: number; max: number };
};

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

async function measure(store: MemoryStore, backend: StoreKind): Promise<ScaleResult> {
  const needles: ScaleResult["needles"] = [];
  for (const needle of NEEDLES) {
    const pack = await store.retrieveContext(PROJECT, needle.token, {
      limit: QUERY_LIMIT,
    });
    needles.push({
      token: needle.token,
      id: needle.id,
      found: pack.memories.some((hit) => hit.memory?.id === needle.id),
    });
  }
  const episodePack = await store.retrieveContext(PROJECT, NEEDLES[0].token, {
    limit: QUERY_LIMIT,
  });
  const episodeNeedle = {
    token: NEEDLES[0].token,
    id: 1,
    found: episodePack.episodes.some((hit) => hit.episode?.id === 1),
  };
  const fixture = buildFixture();
  const rng = mulberry32(1337);
  const latencies: number[] = [];
  for (let index = 0; index < LATENCY_QUERIES; index += 1) {
    const query = [
      fixture.hotWords[Math.floor(rng() * fixture.hotWords.length)],
      fixture.hotWords[Math.floor(rng() * fixture.hotWords.length)],
      fixture.hotWords[Math.floor(rng() * fixture.hotWords.length)],
    ].join(" ");
    const start = performance.now();
    await store.retrieveContext(PROJECT, query, { limit: QUERY_LIMIT });
    latencies.push(performance.now() - start);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const latencyMs = {
    p50: Math.round(percentile(sorted, 0.5) * 100) / 100,
    p95: Math.round(percentile(sorted, 0.95) * 100) / 100,
    mean:
      Math.round((sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 100) /
      100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
  const result: ScaleResult = {
    backend,
    rows: { memories: ROW_COUNT, episodes: ROW_COUNT },
    needles,
    episodeNeedle,
    latencyMs,
  };
  await store.insertBenchmarkRun(
    PROJECT,
    BENCHMARK_NAME,
    JSON.stringify(result),
    JSON.stringify(result, null, 2)
  );
  return result;
}

async function main(): Promise<void> {
  const backend = resolveStoreKind();
  const fixture = buildFixture();
  const seedStart = performance.now();
  let store: MemoryStore;
  let cleanup: () => Promise<void>;
  if (backend === "pg") {
    const databaseUrl = process.env.MEMORANTADO_DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("MEMORANTADO_DATABASE_URL is required when MEMORANTADO_STORE=pg");
    }
    store = await seedPg(databaseUrl, fixture);
    cleanup = async () => {
      const { dropPgDatabase } = await import("../db/pg/admin.js");
      await store.close();
      await dropPgDatabase(databaseUrl, "memorantado_scale_25k");
    };
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorantado-scale-"));
    const dbPath = path.join(dir, "scale.sqlite");
    seedSqlite(dbPath, fixture);
    store = SqliteStore.create(dbPath);
    cleanup = async () => {
      await store.close();
      fs.rmSync(dir, { force: true, recursive: true });
    };
  }
  try {
    const seedMs = Math.round(performance.now() - seedStart);
    const result = await measure(store, backend);
    console.log(JSON.stringify({ ...result, seedMs }, null, 2));
    // Hard assertions: the pg backend must find every needle (uncapped HNSW
    // KNN); sqlite must miss them all (5000-row scan window) — the exact
    // behavior this scenario documents.
    const found = result.needles.filter((needle) => needle.found).length;
    if (backend === "pg" && (found !== NEEDLES.length || !result.episodeNeedle.found)) {
      throw new Error(`pg needle assertion failed: ${found}/${NEEDLES.length} memories`);
    }
    if (backend === "sqlite" && (found !== 0 || result.episodeNeedle.found)) {
      throw new Error(
        `sqlite needle assertion failed: ${found}/${NEEDLES.length} memories`
      );
    }
  } finally {
    await cleanup();
  }
}

await main();
