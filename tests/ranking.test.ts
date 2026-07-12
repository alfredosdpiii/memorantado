import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../src/memory/ranking.js";

describe("reciprocal rank fusion", () => {
  it("rewards documents ranked across independent channels", () => {
    const result = reciprocalRankFusion([
      { name: "bm25", ids: [1, 2, 3] },
      { name: "vector", ids: [2, 4, 1] },
      { name: "overlap", ids: [2, 1] },
    ]);

    expect(result[0]).toMatchObject({
      id: 2,
      ranks: { bm25: 2, vector: 1, overlap: 1 },
    });
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });
});
