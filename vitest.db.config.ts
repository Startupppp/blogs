import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Integration tests against a real, disposable PostgreSQL database (see tests/db/README.md). */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)), "server-only": fileURLToPath(new URL("./tests/support/empty.ts", import.meta.url)) } },
  test: {
    include: ["tests/db/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: ["tests/db/global-setup.ts"],
  },
});
