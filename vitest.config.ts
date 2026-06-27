import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: true,
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 30,
        functions: 35,
        lines: 35,
        statements: 35,
      },
    },
    environment: "node",
    include: ["tests/**/*.test.ts"],
    isolate: true,
    pool: "threads",
    retry: 1,
  },
});
