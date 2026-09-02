import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["tests/real-integration.test.ts", "node_modules/**", "dist/**"],
  },
});
