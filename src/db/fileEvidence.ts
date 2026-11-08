import { InputError, normalizeRepoSource } from "../memory/tags.js";
import type { FileSnapshot, StaleFileEvidence } from "../memory/types.js";

export type FileSnapshotRow = {
  episode_id: number;
  project: string;
  source: string;
  content_hash: string;
  created_at: string;
};

/** One memory citing one version of a file. */
export type FileEvidenceRow = { memory_id: number; source: string; content_hash: string };

const MAX_FILES = 500;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function mapSnapshot(row: FileSnapshotRow): FileSnapshot {
  return {
    episodeId: row.episode_id,
    project: row.project,
    source: row.source,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

/** Validates `[{source: "repo://<path>", contentHash: <sha256 hex>}]`. */
export function normalizeFileHashes(
  files: unknown
): Array<{ source: string; contentHash: string }> {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) {
    throw new InputError(`files must be a non-empty array of at most ${MAX_FILES}`);
  }
  return files.map((file: { source?: unknown; contentHash?: unknown }) => {
    const hash =
      typeof file?.contentHash === "string" ? file.contentHash.toLowerCase() : "";
    if (!SHA256_HEX.test(hash)) throw new InputError("contentHash must be sha256 hex");
    return { source: normalizeRepoSource(file.source), contentHash: hash };
  });
}

/**
 * Memories with evidence from a file whose evidence never cites the file's
 * current content hash: what they quote may have changed.
 */
export function staleFileEvidence(
  files: Array<{ source: string; contentHash: string }>,
  rows: FileEvidenceRow[]
): StaleFileEvidence[] {
  const current = new Map(files.map((file) => [file.source, file.contentHash]));
  const cited = new Map<string, StaleFileEvidence>();
  for (const row of rows) {
    const currentHash = current.get(row.source);
    if (!currentHash) continue;
    const id = `${row.memory_id}\n${row.source}`;
    const entry = cited.get(id) ?? {
      memoryId: row.memory_id,
      source: row.source,
      currentHash,
      evidenceHashes: [],
    };
    if (!entry.evidenceHashes.includes(row.content_hash)) {
      entry.evidenceHashes.push(row.content_hash);
    }
    cited.set(id, entry);
  }
  return [...cited.values()]
    .filter((entry) => !entry.evidenceHashes.includes(entry.currentHash))
    .map((entry) => ({ ...entry, evidenceHashes: entry.evidenceHashes.sort() }))
    .sort(
      (left, right) =>
        left.memoryId - right.memoryId || left.source.localeCompare(right.source)
    );
}
