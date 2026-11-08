import type { FastifyInstance, FastifyReply } from "fastify";
import { resolveProject } from "../mcp/project.js";
import { normalizeFileHashes } from "../db/fileEvidence.js";
import type { MemoryStore } from "../db/store.js";
import { InputError } from "../memory/tags.js";
import type { CandidateMemory, EvidenceInput } from "../memory/types.js";

type EvidenceBody = { sourceEpisodeId?: number; quote?: string; spanStart?: number };
type IdParams = { Params: { id: string } };

/** Evidence named by a request body, or none without `sourceEpisodeId`. */
export function evidenceFrom(body: EvidenceBody): EvidenceInput | undefined {
  if (body.sourceEpisodeId === undefined || body.sourceEpisodeId === null)
    return undefined;
  if (!Number.isSafeInteger(body.sourceEpisodeId) || body.sourceEpisodeId < 1) {
    throw new InputError("sourceEpisodeId must be a positive integer");
  }
  if (body.quote !== undefined && typeof body.quote !== "string") {
    throw new InputError("quote must be a string");
  }
  if (body.spanStart !== undefined && !Number.isSafeInteger(body.spanStart)) {
    throw new InputError("spanStart must be an integer");
  }
  return {
    sourceEpisodeId: body.sourceEpisodeId,
    quote: body.quote,
    spanStart: body.spanStart,
  };
}

function memoryId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new InputError("id must be a positive integer");
  return id;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InputError(`${name} must be a non-empty string`);
  }
  return value;
}

function found<T>(reply: FastifyReply, value: T | null): T | { error: string } {
  if (value !== null) return value;
  reply.code(404);
  return { error: "not_found" };
}

/**
 * Curation of semantic memories (read, supersede, confirm, invalidate,
 * forget, flag a conflict) and file evidence (snapshots and staleness).
 */
export function registerCurationRoutes(app: FastifyInstance, store: MemoryStore): void {
  app.get<{ Querystring: { project?: string; key?: string } }>(
    "/api/semantic-memories/by-key",
    async (req, reply) => {
      const key = requireText(req.query.key, "key");
      return found(
        reply,
        await store.getSemanticMemoryByKey(resolveProject(req.query.project), key)
      );
    }
  );

  app.get<IdParams & { Querystring: { project?: string } }>(
    "/api/semantic-memories/:id",
    async (req, reply) =>
      found(
        reply,
        await store.getSemanticMemory(
          resolveProject(req.query.project),
          memoryId(req.params.id)
        )
      )
  );

  app.delete<IdParams & { Querystring: { project?: string } }>(
    "/api/semantic-memories/:id",
    async (req) => ({
      deleted: await store.deleteSemanticMemory(
        resolveProject(req.query.project),
        memoryId(req.params.id)
      ),
    })
  );

  app.post<
    IdParams & {
      Body: Partial<CandidateMemory> &
        EvidenceBody & { project?: string; content: string };
    }
  >("/api/semantic-memories/:id/supersede", async (req, reply) => {
    const body = req.body;
    const claim = {
      scope: body.scope,
      kind: body.kind,
      subject: body.subject,
      predicate: body.predicate,
      object: body.object,
      content: requireText(body.content, "content"),
      confidence: body.confidence,
      importance: body.importance,
      validFrom: body.validFrom,
      validTo: body.validTo,
      metadata: body.metadata,
      tags: body.tags,
    };
    return found(
      reply,
      await store.supersedeMemory(
        resolveProject(body.project),
        memoryId(req.params.id),
        claim,
        evidenceFrom(body)
      )
    );
  });

  app.post<IdParams & { Body: EvidenceBody & { project?: string } }>(
    "/api/semantic-memories/:id/confirm",
    async (req, reply) =>
      found(
        reply,
        await store.confirmMemory(
          resolveProject(req.body?.project),
          memoryId(req.params.id),
          evidenceFrom(req.body ?? {})
        )
      )
  );

  app.post<IdParams & { Body: { project?: string; reason?: string } }>(
    "/api/semantic-memories/:id/invalidate",
    async (req, reply) =>
      found(
        reply,
        await store.invalidateMemory(
          resolveProject(req.body?.project),
          memoryId(req.params.id),
          req.body?.reason
        )
      )
  );

  app.post<{
    Body: { project?: string; memoryId: number; conflictingId: number; reason: string };
  }>("/api/memory-conflicts", async (req, reply) =>
    found(
      reply,
      await store.createConflict(
        resolveProject(req.body.project),
        memoryId(String(req.body.memoryId)),
        memoryId(String(req.body.conflictingId)),
        requireText(req.body.reason, "reason")
      )
    )
  );

  app.post<{
    Body: {
      project?: string;
      source: string;
      content: string;
      session?: string;
      tags?: string[];
    };
  }>("/api/file-snapshots", async (req) => {
    if (typeof req.body.content !== "string") {
      throw new InputError("content must be a string");
    }
    return store.recordFileSnapshot(resolveProject(req.body.project), {
      source: req.body.source,
      content: req.body.content,
      session: req.body.session,
      tags: req.body.tags,
    });
  });

  app.post<{
    Body: { project?: string; files: Array<{ source: string; contentHash: string }> };
  }>("/api/file-snapshots/stale", async (req) => ({
    stale: await store.findStaleFileEvidence(
      resolveProject(req.body.project),
      normalizeFileHashes(req.body.files)
    ),
  }));
}
