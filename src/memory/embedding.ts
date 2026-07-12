import { embeddingDimension, embedText as embedLocalText } from "./localEmbedding.js";

export type Embedding = {
  provider: string;
  vector: number[];
};

type OllamaEmbedResponse = {
  model?: string;
  embeddings?: number[][];
};

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "embeddinggemma";
const DEFAULT_TIMEOUT_MS = 30_000;

export async function embedText(text: string): Promise<Embedding> {
  const provider = process.env.MEMORANTADO_EMBEDDING_PROVIDER?.trim() || "local-hash";
  if (provider === "local-hash") {
    return { provider, vector: embedLocalText(text) };
  }
  if (provider === "ollama") return embedWithOllama(text);
  throw new Error(`unsupported embedding provider: ${provider}`);
}

function configuredEmbeddingDimension(): number | null {
  const provider = process.env.MEMORANTADO_EMBEDDING_PROVIDER?.trim() || "local-hash";
  if (provider === "local-hash") return embeddingDimension();
  const raw = process.env.MEMORANTADO_OLLAMA_EMBED_DIMENSIONS?.trim();
  if (!raw) return null;
  const dimension = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new Error("MEMORANTADO_OLLAMA_EMBED_DIMENSIONS must be a positive integer");
  }
  return dimension;
}

async function embedWithOllama(text: string): Promise<Embedding> {
  const baseUrl = new URL(
    process.env.MEMORANTADO_OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL
  );
  assertLoopbackOllamaUrl(baseUrl);
  const model =
    process.env.MEMORANTADO_OLLAMA_EMBED_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
  const dimensions = configuredEmbeddingDimension();
  const response = await fetch(new URL("/api/embed", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: text,
      truncate: true,
      ...(dimensions ? { dimensions } : {}),
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Ollama embedding request failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as OllamaEmbedResponse;
  const vector = payload.embeddings?.[0];
  if (!vector?.length || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Ollama embedding response did not contain a valid vector");
  }
  return { provider: `ollama:${payload.model || model}`, vector };
}

function assertLoopbackOllamaUrl(url: URL): void {
  if (url.protocol !== "http:") {
    throw new Error("MEMORANTADO_OLLAMA_URL must use http on a loopback host");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("MEMORANTADO_OLLAMA_URL must use a loopback host");
  }
}
