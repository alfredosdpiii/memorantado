import { afterEach, describe, expect, it, vi } from "vitest";
import { embedText } from "../src/memory/embedding.js";
import { createTestStore, type TestStore } from "./helpers.js";

const ORIGINAL_ENV = { ...process.env };

const databases: TestStore[] = [];

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  while (databases.length) await databases.pop()!.cleanup();
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
    const current = await createTestStore();
    databases.push(current);
    const relevant = await current.store.upsertSemanticMemory("embedding", {
      subject: "project",
      content: "Project codename is quasar.",
    });
    await current.store.upsertSemanticMemory("embedding", {
      subject: "project",
      content: "Project database is SQLite.",
    });

    const result = await current.store.backfillConfiguredEmbeddings("embedding");
    const pack = await current.store.retrieveContext("embedding", "quasar", {
      limit: 2,
    });

    expect(result).toEqual({ provider: "ollama:test-embed", memories: 2, episodes: 0 });
    expect(pack.memories[0].memory?.id).toBe(relevant.id);
    expect(pack.memories[0].scoreParts).toMatchObject({ vector: 1 });
  });

  it("rejects non-loopback Ollama endpoints", async () => {
    process.env.MEMORANTADO_EMBEDDING_PROVIDER = "ollama";
    process.env.MEMORANTADO_OLLAMA_URL = "https://example.com";

    await expect(embedText("test")).rejects.toThrow("loopback host");
  });
});
