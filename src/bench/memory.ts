import { openDb } from "../db/db.js";
import { migrate } from "../db/migrate.js";
import { runMemoryBenchmark } from "../db/hybridMemory.js";

const project = process.argv[2] ?? "benchmark";
const db = openDb();

migrate(db);
const result = await runMemoryBenchmark(db, project);
console.log(JSON.stringify(result, null, 2));
db.close();
