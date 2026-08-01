/**
 * Migrates hybrid-memory data from the SQLite backend to the Postgres
 * backend through the Memorantado JSONL exchange format, preserving ids,
 * evidence, and audit history.
 *
 * Usage:
 *   tsx scripts/migrate-to-pg.ts [--project <name>] \
 *     [--source <sqlite-path>] [--database-url <postgres-url>]
 *
 * Defaults: --source falls back to MEMORANTADO_DB, then
 * ~/.memorantado/memorantado.sqlite; --database-url falls back to
 * MEMORANTADO_DATABASE_URL. Without --project every project found in the
 * source is migrated. Each target project must be empty (the JSONL import
 * refuses to merge into a project that already has hybrid memory data).
 */
import { resolveDbPath } from "../src/db/db.js";
import { SqliteStore } from "../src/db/sqliteStore.js";
import { createPgStore } from "../src/db/pg/pgStore.js";

type Args = {
  project?: string;
  source?: string;
  databaseUrl?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--project" && value) {
      args.project = value;
      index += 1;
    } else if (flag === "--source" && value) {
      args.source = value;
      index += 1;
    } else if (flag === "--database-url" && value) {
      args.databaseUrl = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function countByType(jsonl: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { type: string };
    counts[record.type] = (counts[record.type] ?? 0) + 1;
  }
  return counts;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = args.source ?? resolveDbPath();
  const databaseUrl = args.databaseUrl ?? process.env.MEMORANTADO_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "Postgres target required: pass --database-url or set MEMORANTADO_DATABASE_URL"
    );
  }
  const source = SqliteStore.create(sourcePath);
  const target = await createPgStore(databaseUrl);
  try {
    const projects = await source.getProjects();
    const selected = args.project
      ? projects.filter((project) => project === args.project)
      : projects;
    if (args.project && !selected.length) {
      throw new Error(`project not found in source: ${args.project}`);
    }
    if (!selected.length) {
      console.log("no projects found in source; nothing to migrate");
      return;
    }
    for (const project of selected) {
      const jsonl = await source.exportProjectJsonl(project);
      const result = await target.importProjectJsonl(jsonl, project);
      // Verification: re-export from Postgres and compare per-type counts.
      const sourceCounts = countByType(jsonl);
      const targetCounts = countByType(await target.exportProjectJsonl(project));
      const types = new Set([...Object.keys(sourceCounts), ...Object.keys(targetCounts)]);
      for (const type of types) {
        if ((sourceCounts[type] ?? 0) !== (targetCounts[type] ?? 0)) {
          throw new Error(
            `verification failed for project ${project}: ${type} ` +
              `source=${sourceCounts[type] ?? 0} target=${targetCounts[type] ?? 0}`
          );
        }
      }
      console.log(`migrated ${project}: ${JSON.stringify(result.imported)}`);
    }
    console.log("migration complete; per-type record counts verified");
  } finally {
    await source.close();
    await target.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
