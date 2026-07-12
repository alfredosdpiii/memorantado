import { afterEach, describe, expect, it, vi } from "vitest";
import * as hybrid from "../src/db/hybridMemory.js";
import { backfillConfiguredEmbeddings } from "../src/memory/embeddingBackfill.js";
import { embedText } from "../src/memory/embedding.js";
import { createTestDb } from "./helpers.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("embedding providers", () => {
  it("uses deterministic local embeddings by default", async () => {
    delete process.env.MEMORANTADO_EMBEDDING_PROVIDER;
    const first = await embedText("Ada uses SQLite");
    const second = await embedText("Ada uses SQLite");

    expect(first.provider).toBe("local-hash");
    expect(first.vector).toEqual(second.vector);
    expect(first.vector).toHaveLength(64);
  });

  it("backfills Ollama embeddings and uses them for retrieval", async () => {
    process.env.MEMORANTADO_EMBEDDING_PROVIDER = "ollama";
    process.env.MEMORANTADO_OLLAMA_URL = "http://127.0.0.1:11434";
    process.env.MEMORANTADO_OLLAMA_EMBED_MODEL = "test-embed";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { input: string };
        const vector = body.input.includes("quasar") ? [1, 0] : [0, 1];
        return new Response(
          JSON.stringify({ model: "test-embed", embeddings: [vector] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      })
    );
    const current = createTestDb();
    try {
      const relevant = hybrid.upsertSemanticMemory(current.db, "embedding", {
        subject: "project",
        content: "Project codename is quasar.",
      });
      hybrid.upsertSemanticMemory(current.db, "embedding", {
        subject: "project",
        content: "Project database is SQLite.",
      });

      const result = await backfillConfiguredEmbeddings(current.db, "embedding");
      const pack = await hybrid.retrieveContext(current.db, "embedding", "quasar", {
        limit: 2,
      });

      expect(result).toEqual({ provider: "ollama:test-embed", memories: 2, episodes: 0 });
      expect(pack.memories[0].memory?.id).toBe(relevant.id);
      expect(pack.memories[0].scoreParts).toMatchObject({ vector: 1 });
    } finally {
      current.cleanup();
    }
  });

  it("rejects non-loopback Ollama endpoints", async () => {
    process.env.MEMORANTADO_EMBEDDING_PROVIDER = "ollama";
    process.env.MEMORANTADO_OLLAMA_URL = "https://example.com";

    await expect(embedText("test")).rejects.toThrow("loopback host");
  });
});
