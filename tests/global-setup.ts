import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

/**
 * Builds the test database from the committed migrations, so the suite also
 * proves prisma/migrations actually applies cleanly to an empty database.
 */
const TEST_DB_PATH = "prisma/test-warehouse.db";
const TEST_DATABASE_URL = `file:./${TEST_DB_PATH}`;

export default function setup() {
  // vitest.config.ts sets this for the workers; assert it here too so a
  // misconfiguration can never point the suite at the development database.
  const configured = process.env.DATABASE_URL;
  if (configured && !configured.includes("test-warehouse")) {
    throw new Error(`Test suite refuses to run against DATABASE_URL="${configured}".`);
  }

  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}
