import { createHash } from "node:crypto";

const DIMENSION = 64;

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function embedText(text: string): number[] {
  const vector = Array.from({ length: DIMENSION }, () => 0);

  for (const word of words(text)) {
    const hash = createHash("sha256").update(word).digest();
    const index = hash[0] % DIMENSION;
    const sign = hash[1] % 2 === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.min(word.length, 12) / 12);
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let i = 0; i < length; i += 1) score += left[i] * right[i];
  return Math.max(0, score);
}

export function embeddingDimension(): number {
  return DIMENSION;
}
