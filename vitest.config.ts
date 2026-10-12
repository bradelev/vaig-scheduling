import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // No unit tests exist yet (the first logic lands in E0-T4).
    passWithNoTests: true,
    exclude: [
      "**/node_modules/**",
      // Deno code — covered by `npm run test:functions`.
      "supabase/functions/**",
      // CI-only — covered by `npm run test:integration`.
      "tests/integration/**",
    ],
  },
});
