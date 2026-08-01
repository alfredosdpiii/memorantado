import { openStore } from "../db/store.js";

const project = process.argv[2] ?? "benchmark";
const store = await openStore();

const result = await store.runMemoryBenchmark(project);
console.log(JSON.stringify(result, null, 2));
await store.close();
