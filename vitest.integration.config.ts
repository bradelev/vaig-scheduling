import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Runs only in CI against the runner's Supabase stack (see CLAUDE.md).
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
    // Integration tests hit a real Postgres — allow slower runs.
    testTimeout: 30_000,
  },
});
