import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

const { types } = pg;

// bigint (count(*), setval results) arrives as a string by default; all counts
// and ids in this schema fit comfortably in a JS number.
types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));
// timestamptz -> the exact ISO8601 UTC shape sqlite's
// strftime('%Y-%m-%dT%H:%M:%fZ','now') produces, so mapped rows are
// indistinguishable between backends.
types.setTypeParser(1184, (value: string) => new Date(value).toISOString());

export type { Pool, PoolClient } from "pg";

/** Minimal structural query interface implemented by both Pool and PoolClient. */
export type Queryable = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<Row>>;
};

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Serializes a JS vector for pgvector's text input format. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
