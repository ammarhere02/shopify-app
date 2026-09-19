import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include:
      process.env.RUN_MYSQL_TESTS === "1"
        ? ["tests/**/*.integration.test.ts"]
        : ["tests/**/*.test.ts"],
    exclude:
      process.env.RUN_MYSQL_TESTS === "1"
        ? []
        : ["tests/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
