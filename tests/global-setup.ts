import { execFileSync } from "node:child_process";

/**
 * Builds the test database from the committed migrations, so the suite also
 * proves prisma/migrations actually applies cleanly to an empty database.
 */
const FALLBACK_TEST_DATABASE_URL =
  "postgresql://test-warehouse:test-warehouse@127.0.0.1:5432/test-warehouse";

export default function setup() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? FALLBACK_TEST_DATABASE_URL;
  if (!testDatabaseUrl.includes("test-warehouse")) {
    throw new Error(
      "Test suite refuses to run: TEST_DATABASE_URL must identify a dedicated database containing `test-warehouse`.",
    );
  }

  // Override BOTH names. prisma.config.ts intentionally uses DIRECT_URL; only
  // replacing DATABASE_URL could otherwise migrate the configured production
  // database while a developer believed tests were isolated.
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      DIRECT_URL: testDatabaseUrl,
    },
    stdio: "pipe",
  });
}
