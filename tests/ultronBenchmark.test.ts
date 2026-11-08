import { afterEach, describe, expect, it } from "vitest";
import { runUltronRecallBenchmark } from "../src/bench/ultronRecall.js";
import { createTestStore, type TestStore } from "./helpers.js";

let testStore: TestStore | undefined;

afterEach(async () => {
  await testStore?.cleanup();
  testStore = undefined;
});

describe("Ultron-style scoped recall benchmark", () => {
  it("never leaks other scopes or retired memories and finds stale file evidence", async () => {
    testStore = await createTestStore();
    const result = await runUltronRecallBenchmark(testStore.store);
    expect(result.metrics).toMatchObject({
      queries: 12,
      scopeLeakage: 0,
      retiredLeakage: 0,
      staleDetection: { precision: 1, recall: 1 },
    });
    expect(result.metrics.recallAtK).toBeGreaterThanOrEqual(0.9);
  });
});
