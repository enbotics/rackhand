import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/warehouse/db";
import { SEED_BIN_CODES } from "@/lib/warehouse/types";
import { assertTestDatabase } from "./helpers";

/**
 * Exercises the real seed mechanism (`prisma db seed` -> prisma/seed.ts)
 * against the test database, rather than a reimplementation of it.
 */
function runSeed(): void {
  execFileSync("npx", ["prisma", "db", "seed"], {
    env: { ...process.env, DATABASE_URL: "file:./prisma/test-warehouse.db" },
    stdio: "pipe",
  });
}

describe("bin seed", () => {
  beforeAll(async () => {
    assertTestDatabase();
    // Start from an empty bin table so the seed is what creates the six bins.
    await prisma.movement.deleteMany();
    await prisma.inventory.deleteMany();
    await prisma.part.deleteMany();
    await prisma.bin.deleteMany();
  });

  it("creates the six MVP bins", async () => {
    runSeed();
    const bins = await prisma.bin.findMany({ orderBy: { code: "asc" } });
    expect(bins.map((b) => b.code)).toEqual(["A01", "A02", "A03", "B01", "B02", "B03"]);
    expect(bins).toHaveLength(SEED_BIN_CODES.length);
    expect(bins.every((b) => b.status === "AVAILABLE")).toBe(true);
  });

  it("is idempotent — running it again does not duplicate bins", async () => {
    runSeed();
    runSeed();
    const bins = await prisma.bin.findMany({ orderBy: { code: "asc" } });
    expect(bins).toHaveLength(6);
    expect(bins.map((b) => b.code)).toEqual(["A01", "A02", "A03", "B01", "B02", "B03"]);
  });

  it("does not reset a bin that is already in use", async () => {
    await prisma.bin.update({ where: { code: "A02" }, data: { status: "DISABLED" } });
    runSeed();
    const bin = await prisma.bin.findUniqueOrThrow({ where: { code: "A02" } });
    expect(bin.status).toBe("DISABLED");

    await prisma.bin.update({ where: { code: "A02" }, data: { status: "AVAILABLE" } });
  });
});
