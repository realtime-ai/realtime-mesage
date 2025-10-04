import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "rtm-sdk/src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "rtm-sdk/dist"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules",
        "dist",
        "rtm-sdk/dist",
        "**/*.test.ts",
        "src/server.ts",
        "src/config.ts",
        "benchmark",
        "examples",
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
