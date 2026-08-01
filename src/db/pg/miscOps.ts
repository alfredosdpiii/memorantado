import { withTransaction, type Pool } from "./client.js";

export async function replaceWikiProjectionStatePg(
  pool: Pool,
  project: string,
  entries: Array<{
    path: string;
    revision: string;
    contentHash: string;
    generatedAt: string;
  }>
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(`DELETE FROM wiki_projection_state WHERE project = $1`, [project]);
    for (const entry of entries) {
      await client.query(
        `INSERT INTO wiki_projection_state (project, path, revision, content_hash, generated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [project, entry.path, entry.revision, entry.contentHash, entry.generatedAt]
      );
    }
  });
}

export async function wikiProjectionStateCountPg(
  pool: Pool,
  project: string
): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count(*) AS count FROM wiki_projection_state WHERE project = $1`,
    [project]
  );
  return rows[0].count;
}

export async function insertBenchmarkRunPg(
  pool: Pool,
  project: string,
  name: string,
  metricsJson: string,
  report: string | null
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO benchmark_runs (project, name, metrics_json, report)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [project, name, metricsJson, report]
  );
  return rows[0].id;
}

export async function readLatestBenchmarkMetricsPg(
  pool: Pool,
  project: string,
  name: string
): Promise<string | null> {
  const { rows } = await pool.query<{ metrics_json: string }>(
    `SELECT metrics_json FROM benchmark_runs
     WHERE project = $1 AND name = $2 ORDER BY id DESC LIMIT 1`,
    [project, name]
  );
  return rows[0]?.metrics_json ?? null;
}

export async function normalizeBenchmarkTimestampsPg(
  pool: Pool,
  project: string,
  timestamp: string
): Promise<void> {
  await pool.query(`UPDATE episodes SET created_at = $1 WHERE project = $2`, [
    timestamp,
    project,
  ]);
  await pool.query(
    `UPDATE semantic_memories
     SET created_at = $1, updated_at = $1, last_confirmed_at = $1
     WHERE project = $2`,
    [timestamp, project]
  );
  await pool.query(`UPDATE claim_versions SET recorded_at = $1 WHERE project = $2`, [
    timestamp,
    project,
  ]);
  await pool.query(
    `UPDATE memory_evidence SET created_at = $1::timestamptz, ingested_at = $1::text
     WHERE claim_version_id IN (SELECT id FROM claim_versions WHERE project = $2)`,
    [timestamp, project]
  );
}
