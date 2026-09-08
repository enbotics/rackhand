/**
 * One-off: gives a bin a starting stock quantity AND a "current snapshot"
 * evidence photo, so AUDIT_CAPTURE_MODE=simulation has something real to
 * show as this bin's latest known state before any simulated audit ever
 * runs. The photo is one of the bin's own curated local demo images
 * (public/audit-simulation/<BIN>/snapshot.jpg) — same free, no-Supabase
 * storage the simulated audit pool itself uses.
 *
 * DEVELOPMENT / DEMO ONLY, like scripts/demo-stock.ts. Run with:
 *   npx tsx scripts/seed-bin-snapshot.ts <BIN_CODE> <SKU> <QUANTITY>
 */
import "./load-env";
import { prisma } from "../src/lib/warehouse/db";
import { addInventory } from "../src/lib/warehouse/inventory-service";

async function main(): Promise<void> {
  const [binCode, sku, quantityRaw] = process.argv.slice(2);
  const quantity = Number(quantityRaw);
  if (!binCode || !sku || !Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Usage: tsx scripts/seed-bin-snapshot.ts <BIN_CODE> <SKU> <QUANTITY>");
  }

  const bin = await prisma.bin.findUnique({ where: { code: binCode } });
  if (!bin) throw new Error(`No such bin: ${binCode}`);
  const part = await prisma.part.findUnique({ where: { sku } });
  if (!part) throw new Error(`No such part: ${sku}`);

  const existing = await prisma.inventory.findUnique({
    where: { partId_binId: { partId: part.id, binId: bin.id } },
  });
  if (existing) {
    throw new Error(`${binCode} already holds ${existing.quantity} x ${sku} — refusing to double it.`);
  }

  await addInventory({ sku, binCode, quantity });
  console.log(`Placed ${quantity} x ${sku} in ${binCode}.`);

  const evidenceUrl = `/audit-simulation/${binCode}/snapshot.jpg`;
  const now = new Date();
  const run = await prisma.inventoryAuditRun.create({
    data: {
      trigger: "TRUSTED_INTERNAL",
      status: "COMPLETED",
      requestedBinCode: binCode,
      binsPlanned: 1,
      binsCompleted: 1,
      verifiedBins: 1,
      startedAt: now,
      completedAt: now,
    },
  });
  await prisma.binAudit.create({
    data: {
      auditRunId: run.id,
      binId: bin.id,
      expectedPartId: part.id,
      expectedQuantity: quantity,
      observedQuantity: quantity,
      countConfidence: 1,
      countable: true,
      expectedPartPresent: true,
      foreignObjectSuspected: false,
      occlusion: "NONE",
      status: "VERIFIED",
      evidenceUrl,
      inventoryUpdated: false,
      previousQuantity: quantity,
      newQuantity: quantity,
      startedAt: now,
      capturedAt: now,
      completedAt: now,
    },
  });
  console.log(`Recorded ${binCode}'s current snapshot: ${evidenceUrl}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
