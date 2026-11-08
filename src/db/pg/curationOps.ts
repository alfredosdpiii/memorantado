import { contentHash } from "../../memory/localEmbedding.js";
import { normalizeRepoSource, normalizeTags } from "../../memory/tags.js";
import type {
  Episode,
  EvidenceInput,
  FileSnapshot,
  MemoryConflict,
  SemanticMemory,
  StaleFileEvidence,
} from "../../memory/types.js";
import {
  mapSnapshot,
  staleFileEvidence,
  type FileEvidenceRow,
  type FileSnapshotRow,
} from "../fileEvidence.js";
import { mapClaimVersion, type ClaimVersionRow } from "../hybridRows.js";
import { SUPERSEDED_CHAIN_SQL } from "../memoryRules.js";
import { withTransaction, type Pool } from "./client.js";
import { upsertLocalEmbeddingPg } from "./embeddingOps.js";
import { createConflictPg, getEpisodePg, insertEpisodePg } from "./hybridOps.js";
import { attachEvidencePg, getMemoryPg } from "./hybridWrite.js";

/** Mirrors memoryCuration.confirmMemory. */
export async function confirmMemoryPg(
  pool: Pool,
  project: string,
  memoryId: number,
  evidence?: EvidenceInput
): Promise<SemanticMemory | null> {
  const found = await withTransaction(pool, async (client) => {
    const memory = await getMemoryPg(client, project, memoryId);
    if (!memory) return false;
    await client.query(
      `UPDATE semantic_memories SET last_confirmed_at = now() WHERE id = $1`,
      [memoryId]
    );
    if (evidence) {
      const { rows } = await client.query<ClaimVersionRow>(
        `SELECT * FROM claim_versions WHERE memory_id = $1
         ORDER BY recorded_at DESC, id DESC LIMIT 1`,
        [memoryId]
      );
      await attachEvidencePg(
        client,
        memoryId,
        mapClaimVersion(rows[0]),
        evidence,
        memory.content
      );
    }
    return true;
  });
  return found ? getMemoryPg(pool, project, memoryId) : null;
}

/** Mirrors memoryCuration.invalidateMemory. */
export async function invalidateMemoryPg(
  pool: Pool,
  project: string,
  memoryId: number,
  reason?: string
): Promise<SemanticMemory | null> {
  const found = await withTransaction(pool, async (client) => {
    const memory = await getMemoryPg(client, project, memoryId);
    if (!memory) return false;
    const timestamp = new Date().toISOString();
    const metadata = {
      ...memory.metadata,
      invalidation: { at: timestamp, reason: reason?.trim() || null },
    };
    await client.query(
      `UPDATE semantic_memories
       SET status = 'invalidated', metadata_json = $1, updated_at = $2
       WHERE id = $3`,
      [JSON.stringify(metadata), timestamp, memoryId]
    );
    await client.query(
      `UPDATE claim_versions SET status = 'invalidated', retracted_at = COALESCE(retracted_at, $1)
       WHERE memory_id = $2 AND status = 'active'`,
      [timestamp, memoryId]
    );
    return true;
  });
  return found ? getMemoryPg(pool, project, memoryId) : null;
}

/** Mirrors memoryCuration.flagConflict. */
export async function flagConflictPg(
  pool: Pool,
  project: string,
  memoryId: number,
  conflictingId: number,
  reason: string
): Promise<MemoryConflict | null> {
  if (memoryId === conflictingId) return null;
  return withTransaction(pool, async (client) => {
    const pair = [
      await getMemoryPg(client, project, memoryId),
      await getMemoryPg(client, project, conflictingId),
    ];
    if (pair.some((memory) => !memory)) return null;
    return createConflictPg(client, project, memoryId, conflictingId, reason);
  });
}

/** Mirrors memoryCuration.deleteSemanticMemory. */
export async function deleteSemanticMemoryPg(
  pool: Pool,
  project: string,
  memoryId: number
): Promise<boolean> {
  const { rows } = await pool.query<{ id: number }>(
    `WITH doomed AS (${SUPERSEDED_CHAIN_SQL})
     DELETE FROM semantic_memories WHERE id IN (SELECT id FROM doomed) RETURNING id`,
    [project, memoryId]
  );
  return rows.length > 0;
}

/** Mirrors memoryCuration.recordFileSnapshot. */
export async function recordFileSnapshotPg(
  pool: Pool,
  project: string,
  input: { source: string; content: string; session?: string; tags?: string[] }
): Promise<{ snapshot: FileSnapshot; episode: Episode | null; created: boolean }> {
  const source = normalizeRepoSource(input.source);
  const hash = contentHash(input.content);
  const tags = normalizeTags(input.tags);
  const result = await withTransaction(pool, async (client) => {
    // Serializes concurrent snapshots of one file version.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `${project}\n${source}\n${hash}`,
    ]);
    const existing = await client.query<FileSnapshotRow>(
      `SELECT * FROM file_snapshots WHERE project = $1 AND source = $2 AND content_hash = $3`,
      [project, source, hash]
    );
    if (existing.rows[0]) {
      return { row: existing.rows[0], episode: null, created: false };
    }
    const episode = await insertEpisodePg(
      client,
      project,
      {
        session: input.session,
        role: "file",
        content: input.content,
        source,
        metadata: { contentHash: hash },
      },
      tags
    );
    const { rows } = await client.query<FileSnapshotRow>(
      `INSERT INTO file_snapshots (episode_id, project, source, content_hash)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [episode.id, project, source, hash]
    );
    return { row: rows[0], episode, created: true };
  });
  if (result.episode) {
    await upsertLocalEmbeddingPg(
      pool,
      "episode",
      result.episode.id,
      project,
      input.content
    );
  }
  return {
    snapshot: mapSnapshot(result.row),
    episode: result.episode ?? (await getEpisodePg(pool, project, result.row.episode_id)),
    created: result.created,
  };
}

/** Mirrors memoryCuration.findStaleFileEvidence. */
export async function findStaleFileEvidencePg(
  pool: Pool,
  project: string,
  files: Array<{ source: string; contentHash: string }>
): Promise<StaleFileEvidence[]> {
  const { rows } = await pool.query<FileEvidenceRow>(
    `SELECT DISTINCT cv.memory_id, fs.source, fs.content_hash
     FROM file_snapshots fs
     JOIN memory_evidence me ON me.episode_id = fs.episode_id
     JOIN claim_versions cv ON cv.id = me.claim_version_id
     JOIN semantic_memories sm ON sm.id = cv.memory_id
     WHERE fs.project = $1 AND sm.status = 'active' AND fs.source = ANY($2)`,
    [project, [...new Set(files.map((file) => file.source))]]
  );
  return staleFileEvidence(files, rows);
}
