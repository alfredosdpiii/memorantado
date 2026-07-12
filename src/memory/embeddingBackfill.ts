import type Database from "better-sqlite3";
import { contentHash } from "./localEmbedding.js";
import { embedText } from "./embedding.js";

export type EmbeddingBackfillResult = {
  provider: string;
  memories: number;
  episodes: number;
};

export async function backfillConfiguredEmbeddings(
  db: Database.Database,
  project: string
): Promise<EmbeddingBackfillResult> {
  const memories = db
    .prepare("SELECT id, content FROM semantic_memories WHERE project = ? ORDER BY id")
    .all(project) as Array<{ id: number; content: string }>;
  const episodes = db
    .prepare("SELECT id, content FROM episodes WHERE project = ? ORDER BY id")
    .all(project) as Array<{ id: number; content: string }>;
  let provider = "local-hash";
  const upsertMemory = db.prepare(
    `INSERT INTO memory_embeddings (memory_id, provider, dimension, vector_json, content_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET
       provider = excluded.provider,
       dimension = excluded.dimension,
       vector_json = excluded.vector_json,
       content_hash = excluded.content_hash,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  );
  for (const memory of memories) {
    const embedding = await embedText(memory.content);
    provider = embedding.provider;
    upsertMemory.run(
      memory.id,
      embedding.provider,
      embedding.vector.length,
      JSON.stringify(embedding.vector),
      contentHash(memory.content)
    );
  }
  const upsertEpisode = db.prepare(
    `INSERT INTO episode_embeddings (episode_id, provider, dimension, vector_json, content_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(episode_id) DO UPDATE SET
       provider = excluded.provider,
       dimension = excluded.dimension,
       vector_json = excluded.vector_json,
       content_hash = excluded.content_hash,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  );
  for (const episode of episodes) {
    const embedding = await embedText(episode.content);
    provider = embedding.provider;
    upsertEpisode.run(
      episode.id,
      embedding.provider,
      embedding.vector.length,
      JSON.stringify(embedding.vector),
      contentHash(episode.content)
    );
  }
  return { provider, memories: memories.length, episodes: episodes.length };
}
