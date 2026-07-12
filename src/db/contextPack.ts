import type Database from "better-sqlite3";
import type {
  ContextPack,
  GraphContext,
  MemoryConflict,
  RetrievalHit,
} from "../memory/types.js";
import { estimateTokens } from "./hybridRows.js";

export function renderContext(
  memories: RetrievalHit[],
  episodes: RetrievalHit[],
  conflicts: MemoryConflict[],
  graph: GraphContext,
  tokenBudget: number
): string {
  const lines = ["# Retrieved Memory Context"];
  for (const hit of memories) pushMemoryLines(lines, hit);
  for (const hit of episodes) pushEpisodeLine(lines, hit);
  for (const conflict of conflicts) {
    lines.push(
      `- [conflict:${conflict.id}] memory ${conflict.memoryId} conflicts with ${conflict.conflictingId}`
    );
  }
  for (const entity of graph.entities.slice(0, 20)) {
    lines.push(`- [entity:${entity.name}] ${entity.observations.slice(0, 3).join("; ")}`);
  }
  for (const relation of graph.relations.slice(0, 40)) {
    lines.push(
      `- [relation] ${relation.from} -${relation.relationType}-> ${relation.to}`
    );
  }
  return linesWithinBudget(lines, tokenBudget).join("\n");
}

export function logAccess(
  db: Database.Database,
  project: string,
  pack: ContextPack
): void {
  db.prepare(
    `INSERT INTO memory_access_log (project, query, intent, result_json, latency_ms)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    project,
    pack.query,
    pack.intent,
    JSON.stringify({
      mode: pack.mode,
      asOf: pack.asOf,
      recordedAt: pack.recordedAt,
      memoryIds: pack.memories.map((hit) => hit.memory?.id).filter(Boolean),
      claimVersionIds: pack.memories.map((hit) => hit.version?.id).filter(Boolean),
      episodeIds: pack.episodes.map((hit) => hit.id),
      estimatedTokens: pack.estimatedTokens,
    }),
    pack.latencyMs
  );
}

function pushMemoryLines(lines: string[], hit: RetrievalHit): void {
  if (hit.memory) {
    lines.push(
      `- [memory:${hit.id} score=${hit.score.toFixed(3)}] ${hit.memory.content}`
    );
  } else if (hit.version) {
    lines.push(
      `- [claim-version:${hit.id} memory=${hit.version.memoryId} recorded=${hit.version.recordedAt} score=${hit.score.toFixed(3)}] ${hit.version.content}`
    );
  } else {
    return;
  }
  for (const source of hit.sources ?? []) {
    lines.push(`  source episode:${source.id} ${source.content.slice(0, 180)}`);
  }
}

function pushEpisodeLine(lines: string[], hit: RetrievalHit): void {
  if (!hit.episode) return;
  lines.push(
    `- [episode:${hit.id} score=${hit.score.toFixed(3)}] ${hit.episode.content}`
  );
}

function linesWithinBudget(lines: string[], tokenBudget: number): string[] {
  const output: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    tokens += estimateTokens(line);
    if (tokens > tokenBudget) break;
    output.push(line);
  }
  return output;
}
