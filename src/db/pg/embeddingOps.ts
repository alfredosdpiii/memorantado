import { embedText } from "../../memory/embedding.js";
import {
  contentHash,
  embedText as embedLocalText,
  embeddingDimension,
} from "../../memory/localEmbedding.js";
import { toVectorLiteral, type Pool, type Queryable } from "./client.js";

const LOCAL_HASH_PROVIDER = "local-hash";

type EmbeddingTable =
  | "memory_embeddings"
  | "episode_embeddings"
  | "claim_version_embeddings";
type EmbeddingOwnerColumn = "memory_id" | "episode_id" | "claim_version_id";

export function embeddingTarget(target: "memory" | "episode" | "claim_version"): {
  table: EmbeddingTable;
  column: EmbeddingOwnerColumn;
} {
  switch (target) {
    case "memory":
      return { table: "memory_embeddings", column: "memory_id" };
    case "episode":
      return { table: "episode_embeddings", column: "episode_id" };
    case "claim_version":
      return { table: "claim_version_embeddings", column: "claim_version_id" };
  }
}

/**
 * Writes one embedding row per owner. Only provider='local-hash' rows carry
 * the indexed vector(64) column; other providers keep vector_json and are
 * served by the exact-scan channel (mirrors sqlite's per-row provider
 * semantics: the stored provider flips on backfill).
 */
export async function upsertEmbeddingPg(
  db: Queryable,
  target: "memory" | "episode" | "claim_version",
  id: number,
  project: string,
  provider: string,
  vector: number[],
  content: string
): Promise<void> {
  const { table, column } = embeddingTarget(target);
  const indexedVector =
    provider === LOCAL_HASH_PROVIDER && vector.length === embeddingDimension()
      ? toVectorLiteral(vector)
      : null;
  await db.query(
    `INSERT INTO ${table} (${column}, project, provider, dimension, vector_json, embedding, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
     ON CONFLICT (${column}) DO UPDATE SET
       provider = EXCLUDED.provider,
       project = EXCLUDED.project,
       dimension = EXCLUDED.dimension,
       vector_json = EXCLUDED.vector_json,
       embedding = EXCLUDED.embedding,
       content_hash = EXCLUDED.content_hash,
       created_at = now()`,
    [
      id,
      project,
      provider,
      vector.length,
      JSON.stringify(vector),
      indexedVector,
      contentHash(content),
    ]
  );
}

export async function upsertLocalEmbeddingPg(
  db: Queryable,
  target: "memory" | "episode" | "claim_version",
  id: number,
  project: string,
  content: string
): Promise<void> {
  await upsertEmbeddingPg(
    db,
    target,
    id,
    project,
    LOCAL_HASH_PROVIDER,
    embedLocalText(content),
    content
  );
}

export async function backfillConfiguredEmbeddingsPg(
  pool: Pool,
  project: string
): Promise<{ provider: string; memories: number; episodes: number }> {
  const memories = await pool.query<{ id: number; content: string }>(
    `SELECT id, content FROM semantic_memories WHERE project = $1 ORDER BY id`,
    [project]
  );
  const episodes = await pool.query<{ id: number; content: string }>(
    `SELECT id, content FROM episodes WHERE project = $1 ORDER BY id`,
    [project]
  );
  let provider = LOCAL_HASH_PROVIDER;
  for (const memory of memories.rows) {
    const embedding = await embedText(memory.content);
    provider = embedding.provider;
    await upsertEmbeddingPg(
      pool,
      "memory",
      memory.id,
      project,
      embedding.provider,
      embedding.vector,
      memory.content
    );
  }
  for (const episode of episodes.rows) {
    const embedding = await embedText(episode.content);
    provider = embedding.provider;
    await upsertEmbeddingPg(
      pool,
      "episode",
      episode.id,
      project,
      embedding.provider,
      embedding.vector,
      episode.content
    );
  }
  return { provider, memories: memories.rows.length, episodes: episodes.rows.length };
}
