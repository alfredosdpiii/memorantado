import type Database from "better-sqlite3";
import type { MemoryConflict } from "../memory/types.js";
import { mapConflict, type MemoryConflictRow } from "./hybridRows.js";

export function listConflicts(
  db: Database.Database,
  project: string,
  status = "open"
): MemoryConflict[] {
  return (
    db
      .prepare(
        `
      SELECT * FROM memory_conflicts
      WHERE project = ? AND resolution_status = ?
      ORDER BY created_at DESC
    `
      )
      .all(project, status) as MemoryConflictRow[]
  ).map(mapConflict);
}

export function resolveConflict(
  db: Database.Database,
  project: string,
  conflictId: number,
  resolvedMemoryId?: number,
  status: "resolved" | "ignored" = "resolved",
  audit: {
    actor?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  } = {}
): MemoryConflict | null {
  return db.transaction(() => {
    const conflict = db
      .prepare("SELECT * FROM memory_conflicts WHERE project = ? AND id = ?")
      .get(project, conflictId) as MemoryConflictRow | undefined;
    if (!conflict) return null;
    if (status === "resolved") {
      const winnerId = resolvedMemoryId ?? conflict.memory_id;
      if (winnerId !== conflict.memory_id && winnerId !== conflict.conflicting_id) {
        throw new Error("resolved memory must belong to the conflict");
      }
      const loserId =
        winnerId === conflict.memory_id ? conflict.conflicting_id : conflict.memory_id;
      applyResolutionLifecycle(db, project, winnerId, loserId);
    }
    const row = db
      .prepare(
        `UPDATE memory_conflicts
         SET resolution_status = ?, resolved_memory_id = ?,
             resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE project = ? AND id = ? RETURNING *`
      )
      .get(status, resolvedMemoryId ?? null, project, conflictId) as MemoryConflictRow;
    db.prepare(
      `INSERT INTO conflict_resolution_events (
         conflict_id, project, action, resolved_memory_id, actor, reason, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      conflictId,
      project,
      status,
      resolvedMemoryId ?? null,
      audit.actor ?? null,
      audit.reason ?? null,
      audit.metadata ? JSON.stringify(audit.metadata) : null
    );
    return mapConflict(row);
  })();
}

function applyResolutionLifecycle(
  db: Database.Database,
  project: string,
  winnerId: number,
  loserId: number
): void {
  const timestamp = new Date().toISOString();
  db.prepare(
    `UPDATE semantic_memories
     SET status = 'active', supersedes_id = ?, updated_at = ?
     WHERE project = ? AND id = ?`
  ).run(loserId, timestamp, project, winnerId);
  db.prepare(
    `UPDATE semantic_memories
     SET status = 'superseded', updated_at = ?
     WHERE project = ? AND id = ?`
  ).run(timestamp, project, loserId);
  db.prepare(
    `UPDATE claim_versions
     SET status = 'superseded', retracted_at = COALESCE(retracted_at, ?)
     WHERE project = ? AND memory_id = ? AND status = 'active'`
  ).run(timestamp, project, loserId);
  db.prepare(
    `UPDATE claim_versions
     SET status = 'active', retracted_at = NULL
     WHERE id = (
       SELECT id FROM claim_versions WHERE project = ? AND memory_id = ?
       ORDER BY recorded_at DESC, id DESC LIMIT 1
     )`
  ).run(project, winnerId);
}

/** Opens a conflict between two memories, or returns the open one between them. */
export function createConflict(
  db: Database.Database,
  project: string,
  memoryId: number,
  conflictingId: number,
  reason: string
): MemoryConflict {
  const open = db
    .prepare(
      `SELECT * FROM memory_conflicts
       WHERE project = ? AND resolution_status = 'open'
         AND ((memory_id = ? AND conflicting_id = ?) OR (memory_id = ? AND conflicting_id = ?))`
    )
    .get(project, memoryId, conflictingId, conflictingId, memoryId) as
    MemoryConflictRow | undefined;
  if (open) return mapConflict(open);
  const row = db
    .prepare(
      `INSERT INTO memory_conflicts (project, memory_id, conflicting_id, reason)
       VALUES (?, ?, ?, ?) RETURNING *`
    )
    .get(project, memoryId, conflictingId, reason) as MemoryConflictRow;
  return mapConflict(row);
}
