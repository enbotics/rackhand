import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Warehouse service tests run against a dedicated PostgreSQL database, never
 * the development/production database. Both URLs contain the required
 * `test-warehouse` marker checked again by destructive test setup.
 *
 * One SQLite file is shared by the suite, so files run serially and each test
 * resets the warehouse tables first.
 */
export default defineConfig({
  test: {
    environment: "node",
    // .tsx covers the Milestone 10 dashboard component tests, which opt into
    // jsdom per-file with an `@vitest-environment` docblock; everything else
    // stays on the node environment configured above.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    globalSetup: ["./tests/global-setup.ts"],
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://test-warehouse:test-warehouse@127.0.0.1:5432/test-warehouse",
      DIRECT_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://test-warehouse:test-warehouse@127.0.0.1:5432/test-warehouse",
      // The putaway tests drive real simulator operations; the default 300/200
      // ms phases would add seconds per test for no coverage. Tests that need
      // a slow operation (the gantry-busy race) set their own delay and reset
      // the controller. The simulator's own tests construct their instances
      // directly and are unaffected.
      GANTRY_SIM_MOVE_DELAY_MS: "0",
      GANTRY_SIM_PICK_DELAY_MS: "0",
      GANTRY_SIM_DROP_DELAY_MS: "0",
      GANTRY_SIM_HOME_DELAY_MS: "0",
    },
    fileParallelism: false,
    // The seed tests spawn the Prisma CLI (`npx prisma db seed`), which takes
    // seconds per run and exceeds vitest's 5s default on a busy machine.
    testTimeout: 30_000,
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
});
