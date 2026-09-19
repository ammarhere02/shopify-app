import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ||
  loadEnv("test", root, "TEST_").TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "Set TEST_DATABASE_URL to a local MySQL database ending in _test (see .env.example).",
  );
const parsed = new URL(databaseUrl);
if (
  parsed.protocol !== "mysql:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
  !/^\/[a-zA-Z0-9_]+_test$/.test(parsed.pathname)
) {
  throw new Error(
    "Integration tests require a local MySQL database whose name ends in _test.",
  );
}
const env = { ...process.env, DATABASE_URL: databaseUrl, RUN_MYSQL_TESTS: "1" };
for (const args of [
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  ["node_modules/vitest/vitest.mjs", "run"],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
