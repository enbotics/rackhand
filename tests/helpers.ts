import { prisma } from "@/lib/warehouse/db";
import { SEED_BIN_CODES } from "@/lib/warehouse/types";

/** Every dedicated test database URL contains this marker; production does not. */
export const TEST_DATABASE_MARKER = "test-warehouse";

/**
 * Hard stop before anything destructive.
 *
 * A misconfigured runner must never let the destructive reset below point at
 * the configured development or production database.
 * This turns that into a loud failure instead of a lost warehouse.
 */
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes(TEST_DATABASE_MARKER)) {
    throw new Error(
      `Refusing to run destructive test setup against DATABASE_URL="${url}" — ` +
        `it must point at a database whose path contains "${TEST_DATABASE_MARKER}".`,
    );
  }
}

/**
 * Empties every warehouse table and recreates the six seed bins, so each test
 * starts from the same known warehouse. Deletion order respects the
 * onDelete: Restrict relations.
 */
export async function resetWarehouse(): Promise<void> {
  assertTestDatabase();
  // Order matters: CatalogResolution.selectedPartId is onDelete: Restrict, so
  // resolutions must go before the parts they point at.
  await prisma.catalogResolution.deleteMany();
  await prisma.actionApproval.deleteMany();
  // Observability rows (Milestone 12). Purely observational, so their order
  // here is unconstrained; TraceEvent follows AgentTrace by cascade anyway.
  await prisma.traceEvent.deleteMany();
  await prisma.agentTrace.deleteMany();
  await prisma.movement.deleteMany();
  await prisma.inventory.deleteMany();
  await prisma.part.deleteMany();
  await prisma.bin.deleteMany();
  await prisma.bin.createMany({
    data: SEED_BIN_CODES.map((code) => ({ code, status: "AVAILABLE", capacity: 100 })),
  });
}

export const SAMPLE_PART = {
  sku: "BRG-6204",
  canonicalName: "6204 Deep Groove Ball Bearing",
  category: "bearing",
  description: "Single-row deep groove ball bearing",
  lengthMM: 47,
  widthMM: 47,
  heightMM: 14,
};
